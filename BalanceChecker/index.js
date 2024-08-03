require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const cron = require('node-cron');
const { Queue, Worker } = require('bullmq');
const { MESSAGES } = require('../constants');
const DataManager = require('../Database');
const TelegramNotifier = require('../Telegram');
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
  constructor(rpcEndpoints, telegramNotifier, walletAPrivateKey) {
    this.rpcEndpoints = rpcEndpoints;
    this.currentRpcIndex = 0;
    this.connection = new Connection(this.rpcEndpoints[this.currentRpcIndex], 'confirmed');
    this.telegramNotifier = telegramNotifier;
    this.dataManager = new DataManager();
    this.walletAKeypair = Keypair.fromSecretKey(bs58.decode(walletAPrivateKey));
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
      return balance / 1_000_000_000;
    });
  }

  async getTransactionHistory(walletAPublicKeyString) {
    return this.retryOperation(async () => {
      const walletAPublicKey = new PublicKey(walletAPublicKeyString);
      const signatures = await this.connection.getSignaturesForAddress(walletAPublicKey, { limit: 1 });
      if (signatures.length === 0) {
        throw new Error('No transaction signatures found for the given public key.');
      }
      const confirmedTransaction = await this.connection.getTransaction(signatures[0].signature);
      if (!confirmedTransaction) {
        throw new Error('Failed to retrieve confirmed transaction.');
      }
      return confirmedTransaction;
    });
  }

  async returnSolToWalletB(chatId, transactionId, retryCount = 0) {
    try {
      const depositInfo = await this.dataManager.getTransaction(chatId, transactionId);
      if (!depositInfo) {
        throw new Error('Sender address not found for transaction ID: ' + transactionId);
      }

      const { senderPublicKey, amount } = depositInfo;
      const walletBPublicKey = new PublicKey(senderPublicKey);
      const balanceA = await this.checkSolBalance(this.walletAKeypair.publicKey.toBase58());

      if (balanceA < amount) {
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
          fromPubkey: this.walletAKeypair.publicKey,
          toPubkey: walletBPublicKey,
          lamports: lamportsToSend
        })
      );

      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = this.walletAKeypair.publicKey;

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.walletAKeypair],
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
        return this.returnSolToWalletB(chatId, transactionId, retryCount);
      } else if (retryCount < 3) {
        console.error('Error returning SOL to Wallet B:', error);
        console.log(`Retrying (${retryCount + 1}/3)...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        return this.returnSolToWalletB(chatId, transactionId, retryCount + 1);
      } else {
        console.error('Max retries reached. Adding to failed transactions queue.');
        await this.addToFailedTransactionsQueue(chatId, transactionId);
        throw error;
      }
    }
  }

  async runBalanceCheck(chatId, walletAPublicKeyString, minimumSolBalance) {
    try {
      const transaction = await this.getTransactionHistory(walletAPublicKeyString);

      // Ensure the transaction details are logged
      console.log('Transaction:', JSON.stringify(transaction, null, 2));

      const walletBPublicKey = transaction.transaction.message.accountKeys.find(
        key => key.toString() !== walletAPublicKeyString && key.toString() !== this.walletAKeypair.publicKey.toString()
      );

      if (!walletBPublicKey) {
        throw new Error('Unable to determine the sender (Wallet B) from the transaction history.');
      }

      // Save the transaction details to DataManager
      const senderPublicKey = walletBPublicKey.toString();
      const amount = transaction.meta.postBalances[0] / 1_000_000_000;

      // Log the transaction saving details
      console.log(`Saving transaction with senderPublicKey: ${senderPublicKey}, amount: ${amount}`);

      await this.dataManager.saveTransaction(chatId, transaction.transaction.signatures[0], senderPublicKey, amount);

      const solBalanceA = await this.checkSolBalance(walletAPublicKeyString);
      console.log('Wallet A SOL balance:', solBalanceA);

      let message = MESSAGES.BALANCE_CHECK_REPORT;
      message += MESSAGES.SOL_BALANCE_A(solBalanceA);

      if (solBalanceA < minimumSolBalance) {
        message += MESSAGES.INSUFFICIENT_SOL(minimumSolBalance);
        if (solBalanceA > 0) {
          const job = await transactionQueue.add('returnSol', {
            walletBPublicKeyString: senderPublicKey,
            solBalanceA,
            chatId,
            transactionId: transaction.transaction.signatures[0], // Pass the transaction ID
            walletAPrivateKey: bs58.encode(this.walletAKeypair.secretKey)
          }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
          message += MESSAGES.RETURNED_SOL_PENDING(solBalanceA);
          console.log(`Job added to queue: ${job.id}`);
        } else {
          console.log('SOL balance is 0, not returning funds.');
        }
      } else {
        message += MESSAGES.SUFFICIENT_BALANCE;
        await this.walletProcessor.addJob({ chatId });
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

  startPeriodicCheck(chatId, walletAPublicKeyString, minimumSolBalance) {
    cron.schedule('*/1 * * * *', async () => {
      console.log('Running periodic balance check...');
      await this.runBalanceCheck(chatId, walletAPublicKeyString, minimumSolBalance);
    });

    cron.schedule('*/5 * * * *', async () => {
      console.log('Processing failed transactions...');
      await this.processFailedTransactions();
    });
  }
}

const worker = new Worker('transactionQueue', async job => {
  const { walletBPublicKeyString, solBalanceA, chatId, walletAPrivateKey, transactionId } = job.data;
  const balanceChecker = new BalanceChecker(
    [process.env.SOLANA_RPC_ENDPOINT_1, process.env.SOLANA_RPC_ENDPOINT_2],
    new TelegramNotifier(process.env.TELEGRAM_TOKEN),
    walletAPrivateKey
  );
  const signature = await balanceChecker.returnSolToWalletB(chatId, transactionId);
  return { signature, chatId, solBalanceA, walletAPrivateKey };
}, { connection: redisOptions });

worker.on('completed', async (job, result) => {
  console.log(`Transaction job completed: ${job.id}, signature: ${result.signature}`);
  const message = MESSAGES.RETURNED_SOL_SUCCESS(result.solBalanceA, result.signature, { package: 'Markdown' });
  const balanceChecker = new BalanceChecker(
    [process.env.SOLANA_RPC_ENDPOINT_1, process.env.SOLANA_RPC_ENDPOINT_2],
    new TelegramNotifier(process.env.TELEGRAM_TOKEN),
    result.walletAPrivateKey
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
    job.data.walletAPrivateKey
  );
  await balanceChecker.sendTelegramMessage(job.data.chatId);
});

module.exports = BalanceChecker;