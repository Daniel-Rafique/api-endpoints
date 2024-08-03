require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const cron = require('node-cron');
const { Queue, Worker } = require('bullmq');
const { MESSAGES } = require('../constants');
const DataManager = require('../Database');
const TelegramNotifier = require('../Telegram');
const WalletProcessor = require('../WalletProcessor');
const { RateLimiter } = require('limiter');
const fs = require('fs').promises;
const path = require('path');

const redisOptions = {
  host: 'localhost',
  port: 6379,
};

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const transactionQueue = new Queue('transactionQueue', { connection: redisOptions });

class BalanceChecker {
  constructor(rpcEndpoints, telegramNotifier, receiverPrivateKey) {
    this.rpcEndpoints = rpcEndpoints;
    this.currentRpcIndex = 0;
    this.connection = new Connection(this.rpcEndpoints[this.currentRpcIndex], 'confirmed');
    this.telegramNotifier = telegramNotifier;
    this.dataManager = new DataManager();
    this.receiverKeypair = Keypair.fromSecretKey(bs58.decode(receiverPrivateKey));
    this.walletProcessor = new WalletProcessor();
    this.messageCache = {};
    this.limiter = new RateLimiter({ tokensPerInterval: 10, interval: 'second' });
    this.failedTransactionsQueue = path.join(__dirname, 'failedTransactions.json');
    this.processingFailedTransactions = false;
  }

  switchRpcEndpoint() {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcEndpoints.length;
    this.connection = new Connection(this.rpcEndpoints[this.currentRpcIndex], 'confirmed');
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

  async checkSolBalance(publicKeyString) {
    return this.retryOperation(async () => {
      const publicKey = new PublicKey(publicKeyString);
      const balance = await this.connection.getBalance(publicKey);
      console.log(balance)
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
      console.log('Token Balance: ', tokenBalance);

      return tokenBalance;
    });
  }

  async getTransactionHistory(chatId, receiverPublicKeyString) {
    console.log(chatId)
    return this.retryOperation(async () => {
      const receiverPublicKey = new PublicKey(receiverPublicKeyString);
      const signatures = await this.connection.getSignaturesForAddress(receiverPublicKey, { limit: 1 });
      console.log(signatures)

      if (signatures.length === 0) {
        throw new Error('No transaction signatures found for the given public key.');
      }

      const confirmedTransaction = await this.connection.getTransaction(signatures[0].signature);

      console.log(confirmedTransaction)
      if (!confirmedTransaction) {
        throw new Error('Failed to retrieve confirmed transaction.');
      }

      // Log the entire confirmedTransaction for debugging
      console.log('Confirmed Transaction:', JSON.stringify(confirmedTransaction, null, 2));

      // Extract and log the details of the transaction
      const { transaction, meta } = confirmedTransaction;
      console.log('Transaction Details:', transaction);
      console.log('Transaction Meta:', meta);

      // Identify the sender (Wallet B)
      const senderPublicKey = transaction.message.accountKeys[0]

      if (!senderPublicKey) {
        throw new Error('Unable to determine the sender (Wallet B) from the transaction history.');
      }

      console.log(`Sender (Wallet B) PublicKey: ${senderPublicKey}`);

      const amount = meta.preBalances[0] / 1_000_000_000;
      await this.dataManager.saveTransaction(chatId, transaction.signatures[0], senderPublicKey.toString(), amount);

      return confirmedTransaction;
    });
  }

  async returnSolToSender(chatId, transactionId, retryCount = 0) {
    try {
      console.log(chatId)
      // const senderPublicKey = '8HBx72n7HNkD3uk536yFG62vuThuFKffmUEdX8kDzdvu';
      // const amount = 0.005;

      const depositInfo = await this.dataManager.getTransaction(chatId, transactionId);

      if (!depositInfo) {
        await this.getTransactionHistory(chatId, this.receiverKeypair.publicKey.toString());
      }

      const { senderPublicKey, amount } = depositInfo;
      console.log(depositInfo)
      const senderPublicKeyInstance = new PublicKey(senderPublicKey);
      const receiverBalance = await this.checkSolBalance(this.receiverKeypair.publicKey.toBase58());
      console.log(receiverBalance)

      if (receiverBalance < amount) {
        console.log('Insufficient balance to return SOL');
        return null;
      }

      const lamportsToSend = amount * 1_000_000_000;

      if (lamportsToSend <= 0) {
        console.log('Not enough balance to cover transaction fees');
        return null;
      }

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.receiverKeypair.publicKey,
          toPubkey: senderPublicKeyInstance,
          lamports: lamportsToSend
        })
      );

      const { blockhash } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = this.receiverKeypair.publicKey;

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.receiverKeypair],
        {
          maxRetries: 5,
          commitment: 'confirmed',
        }
      );

      console.log('Transaction signature:', signature);
      return signature;
    } catch (error) {
      console.error('Error returning SOL to Wallet B:', error);
      if (error.message.includes('block height exceeded')) {
        console.error('Block height exceeded error. Retrying with new blockhash...');
        return this.returnSolToSender(chatId, transactionId, retryCount);
      } else if (retryCount < 3) {
        console.error('Error returning SOL to Wallet B:', error);
        console.log(`Retrying (${retryCount + 1}/3)...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        return this.returnSolToSender(chatId, transactionId, retryCount + 1);
      } else {
        console.error('Max retries reached. Adding to failed transactions queue.');
        await this.addToFailedTransactionsQueue(chatId, transactionId);
        throw error;
      }
    }
  }

  async addToFailedTransactionsQueue(chatId, transactionId) {
    const failedTransaction = {
      chatId,
      transactionId,
      timestamp: Date.now(),
      attempts: 0
    };

    try {
      let queue = [];
      try {
        const data = await fs.readFile(this.failedTransactionsQueue, 'utf8');
        queue = JSON.parse(data);
      } catch (err) {
        // File doesn't exist or is empty, start with an empty queue
      }

      queue.push(failedTransaction);
      await fs.writeFile(this.failedTransactionsQueue, JSON.stringify(queue, null, 2));

      this.processFailedTransactions();
    } catch (err) {
      console.error('Error adding to failed transactions queue:', err);
    }
  }

  async processFailedTransactions() {
    if (this.processingFailedTransactions) return;
    this.processingFailedTransactions = true;

    try {
      let queue = [];
      try {
        const data = await fs.readFile(this.failedTransactionsQueue, 'utf8');
        queue = JSON.parse(data);
      } catch (err) {
        this.processingFailedTransactions = false;
        return;
      }

      for (let i = 0; i < queue.length; i++) {
        const transaction = queue[i];
        try {
          await this.returnSolToSender(transaction.chatId, transaction.transactionId);
          queue.splice(i, 1);
          i--;
        } catch (error) {
          console.error('Error processing failed transaction:', error);
          transaction.attempts++;
          if (transaction.attempts >= 5) {
            transaction.requiresManualIntervention = true;
            await this.notifyAdminForManualIntervention(transaction);
          }
        }
      }

      await fs.writeFile(this.failedTransactionsQueue, JSON.stringify(queue, null, 2));
    } catch (err) {
      console.error('Error processing failed transactions:', err);
    } finally {
      this.processingFailedTransactions = false;
    }
  }

  async notifyAdminForManualIntervention(transaction) {
    const message = `URGENT: Manual intervention required for failed transaction.\n` +
      `Transaction ID: ${transaction.transactionId}\n` +
      `Attempts: ${transaction.attempts}\n` +
      `First attempt: ${new Date(transaction.timestamp).toISOString()}`;

    await this.telegramNotifier.sendTelegramMessage(process.env.ADMIN_CHAT_ID, message);
  }

  async runBalanceCheck(chatId, receiverPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress) {
    try {
      const transaction = await this.getTransactionHistory(chatId, receiverPublicKeyString);
      console.log('Transaction:', transaction);

      const senderPublicKey = transaction.transaction.message.accountKeys.find(
        key => key.toString() !== receiverPublicKeyString && key.toString() !== this.receiverKeypair.publicKey.toString()
      );

      if (!senderPublicKey) {
        throw new Error('Unable to determine the sender (Wallet B) from the transaction history.');
      }

      const solBalanceA = await this.checkSolBalance(receiverPublicKeyString);

      console.log('Wallet A SOL balance:', solBalanceA);

      let message = MESSAGES.BALANCE_CHECK_REPORT;
      message += MESSAGES.SOL_BALANCE_A(solBalanceA);
      const isSolValid = solBalanceA >= minimumSolBalance;

      const tokenBalanceB = await this.checkTokenBalance(senderPublicKey.toString(), tokenMintAddress);
      console.log('Wallet B Token balance:', tokenBalanceB);

      message += MESSAGES.TOKEN_BALANCE_B(tokenBalanceB);
      const isTokenValid = tokenBalanceB >= minimumTokenBalance;

      console.log('SOL balance:', solBalanceA, 'Token balance:', tokenBalanceB);

      if (isSolValid && isTokenValid) {
        message += MESSAGES.SUFFICIENT_BALANCE;
        await this.walletProcessor.addJob({ chatId });
      } else {
        if (!isSolValid) {
          message += MESSAGES.INSUFFICIENT_SOL(minimumSolBalance);
        }
        if (!isTokenValid) {
          message += MESSAGES.INSUFFICIENT_TOKEN(minimumTokenBalance);
        }
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

      await this.sendTelegramMessage(chatId, message);
    } catch (error) {
      console.error('Error during balance check:', error);
      await this.sendTelegramMessage(chatId, MESSAGES.ERROR_DURING_CHECK(error.message));
    }
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
    cron.schedule('*/1 * * * *', async () => {
      console.log('Running periodic balance check...');
      await this.runBalanceCheck(chatId, receiverPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress);
    });

    cron.schedule('*/5 * * * *', async () => {
      console.log('Processing failed transactions...');
      await this.processFailedTransactions();
    });
  }
}

const worker = new Worker('transactionQueue', async job => {
  const { senderPublicKeyString, solBalanceA, chatId, receiverPrivateKey, transactionId } = job.data;
  console.log('Worker received receiverPrivateKey:', receiverPrivateKey);

  const balanceChecker = new BalanceChecker(
    [process.env.SOLANA_RPC_ENDPOINT_1, process.env.SOLANA_RPC_ENDPOINT_2],
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
    [process.env.SOLANA_RPC_ENDPOINT_1, process.env.SOLANA_RPC_ENDPOINT_2],
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
    [process.env.SOLANA_RPC_ENDPOINT_1, process.env.SOLANA_RPC_ENDPOINT_2],
    new TelegramNotifier(process.env.TELEGRAM_TOKEN),
    job.data.receiverPrivateKey
  );
  await balanceChecker.sendTelegramMessage(job.data.chatId);
});

module.exports = BalanceChecker;
