require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const cron = require('node-cron');
const { Queue, Worker } = require('bullmq');
const { MESSAGES } = require('../constants');
const DataManager = require('../database');
const TelegramNotifier = require('../Telegram');
const WalletProcessor = require('../WalletProcessor');
const { RateLimiter } = require('limiter');
const fs = require('fs').promises;
const path = require('path');
const WebSocket = require('ws');

const SOLANA_RPC_ENDPOINT_1 = process.env.SOLANA_RPC_ENDPOINT_1;
const SOLANA_RPC_ENDPOINT_2 = process.env.SOLANA_RPC_ENDPOINT_2;
const SOLANA_WEBSOCKET_1 = process.env.SOLANA_WEBSOCKET_1;
const SOLANA_WEBSOCKET_2 = process.env.SOLANA_WEBSOCKET_2;

const redisOptions = {
  host: 'localhost',
  port: 6379,
};
const PROGRAM_ID = process.env.PROGRAM_ID;
const TOKEN_PROGRAM_ID = new PublicKey(PROGRAM_ID);
const transactionQueue = new Queue('transactionQueue', { connection: redisOptions });

class BalanceChecker {
  constructor(rpcEndpoints, websocketEndpoints, telegramNotifier, receiverPrivateKey) {
    this.rpcEndpoints = rpcEndpoints;
    this.websocketEndpoints = websocketEndpoints;
    this.currentRpcIndex = 0;
    this.currentWebSocketIndex = 0;
    this.connection = new Connection(this.rpcEndpoints[this.currentRpcIndex], 'confirmed');
    this.telegramNotifier = telegramNotifier;
    this.dataManager = new DataManager();
    this.receiverKeypair = null;

    try {
      if (typeof receiverPrivateKey !== 'string') {
        throw new TypeError('Receiver private key must be a string');
      }
      this.receiverKeypair = Keypair.fromSecretKey(bs58.decode(receiverPrivateKey));
    } catch (error) {
      console.error('Error decoding receiver private key:', error.message);
      throw error;
    }

    this.walletProcessor = new WalletProcessor();
    this.messageCache = {};
    this.limiter = new RateLimiter({ tokensPerInterval: 10, interval: 'second' });
    this.failedTransactionsQueue = path.join(__dirname, 'failedTransactions.json');
    this.processingFailedTransactions = false;

    this.messageQueue = [];
    this.ws = null;

    this.listenForTransactions();
  }

  listenForTransactions(chatId) {
    this.ws = new WebSocket(this.websocketEndpoints[this.currentWebSocketIndex]);

    this.ws.on('open', () => {
      console.log('WebSocket connection opened');
      this.processMessageQueue();
      this.sendMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{
          mentions: [this.receiverKeypair.publicKey.toString()]
        }]
      });
    });

    this.ws.on('message', async (data) => {
      const response = JSON.parse(data);
      console.log('Received WebSocket message:', response);
      if (response.method === 'logsNotification') {
        const transactionSignature = response.params.result.value.signature;
        console.log(`New transaction: ${transactionSignature}`);
        if (transactionSignature) {
          await this.handleTransaction(chatId, transactionSignature);
        }
      }
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    this.ws.on('close', () => {
      console.log('WebSocket connection closed, reconnecting...');
      setTimeout(() => this.listenForTransactions(chatId), 1000);
    });
  }

  sendMessage(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      console.log('Sending message:', message);
      this.ws.send(JSON.stringify(message));
    } else {
      console.log('WebSocket not open, queueing message:', message);
      this.messageQueue.push(message);
    }
  }

  processMessageQueue() {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      this.sendMessage(message);
    }
  }

  switchWebSocketEndpoint() {
    this.currentWebSocketIndex = (this.currentWebSocketIndex + 1) % this.websocketEndpoints.length;
    console.log(`Switched to WebSocket endpoint: ${this.websocketEndpoints[this.currentWebSocketIndex]}`);
  }

  switchRpcEndpoint() {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcEndpoints.length;
    this.connection = new Connection(this.rpcEndpoints[this.currentRpcIndex], 'confirmed');
  }

  async handleTransaction(chatId, signature) {
    try {
      const confirmedTransaction = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!confirmedTransaction) {
        console.error('Failed to retrieve confirmed transaction');
        return;
      }

      const { transaction, meta } = confirmedTransaction;

      // Find the account index of the receiver and the sender
      const receiverIndex = transaction.message.accountKeys.findIndex(key => key.toString() === this.receiverKeypair.publicKey.toString());
      const senderIndex = transaction.message.accountKeys.findIndex(key => key.toString() !== this.receiverKeypair.publicKey.toString());

      if (receiverIndex === -1 || senderIndex === -1) {
        throw new Error('Receiver or Sender public key not found in the transaction.');
      }

      // Extract the pre- and post- balances of the receiver
      const receiverPreBalance = meta.preBalances[receiverIndex];
      const receiverPostBalance = meta.postBalances[receiverIndex];

      // Calculate the amount sent to the receiver in lamports
      const amountReceived = receiverPostBalance - receiverPreBalance;
      console.log('Transaction Amount in lamports:', amountReceived);

      const senderPublicKey = transaction.message.accountKeys[senderIndex];
      const tokenBalance = await this.checkTokenBalance(chatId, senderPublicKey.toString(), process.env.TOKEN_MINT_ADDRESS);


      if (amountReceived < this.minimumSolBalance * 1_000_000_000 || tokenBalance < this.minimumTokenBalance) {

        if (!senderPublicKey) {
          console.error('Sender public key not found in the transaction');
          return;
        }

        console.log(`Returning ${amountReceived / 1_000_000_000} SOL to sender: ${senderPublicKey}`);

        const returnTransaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: this.receiverKeypair.publicKey,
            toPubkey: new PublicKey(senderPublicKey),
            lamports: amountReceived - 5000 // Adjusting for transaction fee in lamports
          })
        );

        const signature = await sendAndConfirmTransaction(
          this.connection,
          returnTransaction,
          [this.receiverKeypair],
          { commitment: 'confirmed' }
        );

        console.log(`Returned ${amountReceived / 1_000_000_000} SOL to sender: ${senderPublicKey}`);
        await this.sendTelegramMessage(chatId, `✅ Successfully returned ${amountReceived / 1_000_000_000} SOL to sender: ${senderPublicKey.toString()}. \nTX signature: ${signature}`);
      }
    } catch (error) {
      console.error('Error handling transaction:', error);
    }
  }

  async returnSolToSender(chatId, transactionId) {
    try {
      const transaction = await this.connection.getTransaction(transactionId, {
        maxSupportedTransactionVersion: 0,
      });
      if (!transaction) {
        throw new Error('Transaction not found');
      }

      const { transaction: tx, meta } = transaction;

      // Find the account index of the receiver and the sender
      const receiverIndex = tx.message.accountKeys.findIndex(key => key.toString() === this.receiverKeypair.publicKey.toString());
      const senderIndex = tx.message.accountKeys.findIndex(key => key.toString() !== this.receiverKeypair.publicKey.toString());

      if (receiverIndex === -1 || senderIndex === -1) {
        throw new Error('Receiver or Sender public key not found in the transaction.');
      }

      // Extract the pre- and post- balances of the receiver
      const receiverPreBalance = meta.preBalances[receiverIndex];
      const receiverPostBalance = meta.postBalances[receiverIndex];

      // Calculate the amount sent to the receiver in lamports
      const amountReceived = receiverPostBalance - receiverPreBalance;
      console.log('Transaction Amount in lamports:', amountReceived);

      const senderPublicKey = tx.message.accountKeys[senderIndex];

      const solBalance = await this.checkSolBalance(this.receiverKeypair.publicKey.toString());
      console.log(`Returning ${solBalance} SOL to sender: ${senderPublicKey}`);

      const returnTransaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.receiverKeypair.publicKey,
          toPubkey: new PublicKey(senderPublicKey),
          lamports: amountReceived - 5000 // Adjusting for transaction fee in lamports
        })
      );

      let signature;
      try {
        signature = await sendAndConfirmTransaction(
          this.connection,
          returnTransaction,
          [this.receiverKeypair],
          { commitment: 'confirmed' }
        );
      } catch (error) {
        if (error.message.includes('block height exceeded')) {
          console.log('Transaction expired, retrying with updated block height');
          // Update block height and retry
          const latestBlockhash = await this.connection.getLatestBlockhash();
          returnTransaction.recentBlockhash = latestBlockhash.blockhash;
          signature = await sendAndConfirmTransaction(
            this.connection,
            returnTransaction,
            [this.receiverKeypair],
            { commitment: 'confirmed' }
          );
        } else {
          throw error;
        }
      }

      console.log(`Returned ${amountReceived / 1_000_000_000} SOL to sender: ${senderPublicKey}`);
      await this.sendTelegramMessage(chatId, `✅ Successfully returned ${amountReceived / 1_000_000_000} SOL to sender: ${senderPublicKey.toString()}. Transaction signature: ${signature}`);
      return signature;
    } catch (error) {
      console.error('Error returning SOL to sender:', error);
      throw error;
    }
  }

  async retryOperation(operation, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          this.limiter.removeTokens(1, (err, remainingRequests) => {
            if (err) reject(err);
            else resolve(remainingRequests);
          });
        });

        return await operation();
      } catch (error) {
        if (attempt === maxRetries - 1) throw error;
        console.log(`Attempt ${attempt + 1} failed, retrying...`);
        this.switchRpcEndpoint();
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  async runBalanceCheck(chatId, receiverPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress) {
    this.minimumSolBalance = minimumSolBalance; // Set the minimumSolBalance for use in handleTransaction
    this.chatId = chatId; // Store chatId for use in other methods
    try {
      const solBalanceA = await this.checkSolBalance(receiverPublicKeyString);
      console.log('Receiver SOL balance:', solBalanceA);

      let message = MESSAGES.BALANCE_CHECK_REPORT;
      message += MESSAGES.SOL_BALANCE_A(solBalanceA);
      const isSolValid = solBalanceA >= minimumSolBalance;

      // Find the last transaction sender's public key (assume last transaction is the relevant one)
      const transaction = await this.getLatestTransaction(receiverPublicKeyString);
      const senderPublicKey = transaction?.transaction.message.accountKeys.find(
        key => key.toString() !== receiverPublicKeyString && key.toString() !== this.receiverKeypair.publicKey.toString()
      );

      if (!senderPublicKey) {
        throw new Error('Unable to determine the sender from the transaction history.');
      }

      const tokenBalance = await this.checkTokenBalance(senderPublicKey.toString(), tokenMintAddress);
      console.log('Sender Token balance:', tokenBalance);

      message += MESSAGES.TOKEN_BALANCE_B(tokenBalance);
      const isTokenValid = tokenBalance >= minimumTokenBalance;

      console.log('SOL balance:', solBalanceA, 'Token balance:', tokenBalance);

      if (isSolValid && isTokenValid) {
        message += MESSAGES.SUFFICIENT_BALANCE;
        const transactionComplete = true;
        await this.dataManager.saveTransactionComplete(chatId.toString(), transactionComplete);
        await this.walletProcessor.addJob({ chatId });
      } else {
        if (!isSolValid) {
          message += MESSAGES.INSUFFICIENT_SOL(minimumSolBalance);
          if (solBalanceA > 0) {
            const job = await transactionQueue.add('returnSol', {
              senderPublicKeyString: senderPublicKey.toString(),
              solBalanceA,
              chatId,
              transactionId: transaction.transaction.signatures[0], // Pass the transaction ID
              receiverPrivateKey: bs58.encode(this.receiverKeypair.secretKey)
            }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
            message += MESSAGES.RETURNED_SOL_PENDING(solBalanceA);
            console.log(`Job added to queue: ${job.id}`);
          } else {
            console.log('SOL balance is 0, not returning funds.');
          }
        }
        if (!isTokenValid) {
          message += MESSAGES.INSUFFICIENT_TOKEN(minimumTokenBalance);
        }
      }

      await this.sendTelegramMessage(chatId, message);
    } catch (error) {
      console.error('Error during balance check:', error);
      await this.sendTelegramMessage(chatId, MESSAGES.ERROR_DURING_CHECK(error.message));
    }
  }

  async getLatestTransaction(receiverPublicKeyString) {
    const receiverPublicKey = new PublicKey(receiverPublicKeyString);
    const signatures = await this.connection.getSignaturesForAddress(receiverPublicKey, { limit: 1 });
    if (signatures.length === 0) {
      throw new Error('No transaction signatures found for the given public key.');
    }

    const confirmedTransaction = await this.connection.getTransaction(signatures[0].signature, {
      maxSupportedTransactionVersion: 0,
    });
    return confirmedTransaction;
  }

  async checkSolBalance(publicKeyString) {
    return this.retryOperation(async () => {
      const publicKey = new PublicKey(publicKeyString);
      const balance = await this.connection.getBalance(publicKey);
      console.log(balance);
      return balance / 1_000_000_000;
    });
  }

  async checkTokenBalance(walletPublicKeyString, tokenMintAddress) {
    return this.retryOperation(async () => {
      console.log('Checking token balance for wallet:', walletPublicKeyString, 'with mint:', tokenMintAddress);
      const walletPublicKey = new PublicKey(walletPublicKeyString);
      const tokenMintPublicKey = new PublicKey(tokenMintAddress);

      console.log('Validated Wallet Public Key:', walletPublicKey.toString());
      console.log('Validated Token Mint Address:', tokenMintPublicKey.toString());

      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(walletPublicKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      console.log('Fetched Token Accounts:', JSON.stringify(tokenAccounts, null, 2));

      if (!tokenAccounts) {
        console.warn('No token accounts found.');
        return 0;
      }

      const tokenAccount = tokenAccounts.value.find(
        account => account.account.data.parsed.info.owner === walletPublicKey.toString()
      );

      if (!tokenAccount) {
        console.warn('No token account matching the mint address found.');
        return 0;
      }

      const tokenBalance = parseFloat(tokenAccount.account.data.parsed.info.tokenAmount.uiAmount);
      console.log('Token Balance:', tokenBalance);

      return tokenBalance;
    });
  }

  async sendTelegramMessage(chatId, text) {
    const cacheKey = `${chatId}`;
    if (this.messageCache[cacheKey] !== text) {
      await this.telegramNotifier.sendTelegramMessage(chatId, text);
      this.messageCache[cacheKey] = text;
    } else {
      console.log('Duplicate message detected, skipping send.');
    }
  }

  startPeriodicCheck(chatId, receiverPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress) {
    const transactionComplete = this.dataManager.getCollection(chatId.toString());
    const cronOneMinute = transactionComplete.complete ? true : ('*/1 * * * *');
    const cronFiveMinute = transactionComplete.complete ? true : ('*/5 * * * *');
    cron.schedule(cronOneMinute, async () => {
      if (!transactionComplete.complete) {
        console.log('Running periodic balance check...');
        await this.runBalanceCheck(chatId, receiverPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress);
      }
      console.log('Transaction already completed.');
    });

    cron.schedule(cronFiveMinute, async () => {
      console.log('Processing failed transactions...');
      await this.processFailedTransactions();
    });
  }
}

const worker = new Worker('transactionQueue', async job => {
  const { solBalanceA, chatId, receiverPrivateKey, transactionId } = job.data;
  console.log('Worker received receiverPrivateKey:', receiverPrivateKey);

  const balanceChecker = new BalanceChecker(
    [SOLANA_RPC_ENDPOINT_1, SOLANA_RPC_ENDPOINT_2],
    [SOLANA_WEBSOCKET_1, SOLANA_WEBSOCKET_2],
    new TelegramNotifier(process.env.TELEGRAM_TOKEN),
    receiverPrivateKey
  );

  const signature = await balanceChecker.returnSolToSender(chatId, transactionId);
  return { signature, chatId, solBalanceA, receiverPrivateKey };
}, { connection: redisOptions });

worker.on('completed', async (job, result) => {
  console.log(`Transaction job completed: ${job.id}, signature: ${result.signature}`);
  const message = MESSAGES.RETURNED_SOL_SUCCESS(result.solBalanceA, result.signature, { package: 'Markdown' });
  const balanceChecker = new BalanceChecker(
    [SOLANA_RPC_ENDPOINT_1, SOLANA_RPC_ENDPOINT_2],
    [SOLANA_WEBSOCKET_1, SOLANA_WEBSOCKET_2],
    new TelegramNotifier(process.env.TELEGRAM_TOKEN),
    result.receiverPrivateKey
  );
  if (result.signature) {
    await balanceChecker.sendTelegramMessage(result.chatId, message);
  }
});

worker.on('failed', async (job, err) => {
  console.error(`Transaction job failed: ${job.id}`, err);
  const balanceChecker = new BalanceChecker(
    [SOLANA_RPC_ENDPOINT_1, SOLANA_RPC_ENDPOINT_2],
    [SOLANA_WEBSOCKET_1, SOLANA_WEBSOCKET_2],
    new TelegramNotifier(process.env.TELEGRAM_TOKEN),
    job.data.receiverPrivateKey
  );
  // await balanceChecker.sendTelegramMessage(job.data.chatId, MESSAGES.RETURNED_SOL_FAILURE(job.data.solBalanceA, err.message));
});

module.exports = BalanceChecker;