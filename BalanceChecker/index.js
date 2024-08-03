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
  constructor(rpcEndpoints, telegramNotifier, walletAPrivateKey) {
    console.log('Wallet A Private Key:', walletAPrivateKey);
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
        // Use a promise wrapper for the rate limiter
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

  async getTransactionHistory(walletAPublicKeyString) {
    return this.retryOperation(async () => {
      const walletAPublicKey = new PublicKey(walletAPublicKeyString);
      console.log('Wallet A Public Key:', walletAPublicKey.toString());
      const signatures = await this.connection.getSignaturesForAddress(walletAPublicKey, { limit: 1 });
      const confirmedTransaction = await this.connection.getTransaction(signatures[0].signature);
      return confirmedTransaction;
    });
  }

  async returnSolToWalletB(walletBPublicKeyString, retryCount = 0) {
    try {
      const walletBPublicKey = new PublicKey(walletBPublicKeyString);
      const balanceA = await this.checkSolBalance(this.walletAKeypair.publicKey.toBase58());

      if (balanceA <= 0) {
        console.log('Insufficient balance to return SOL');
        return null;
      }

      // Get the minimum balance for rent exemption
      const minBalanceForRentExemption = await this.connection.getMinimumBalanceForRentExemption(0);

      // Calculate lamports to send, leaving enough for rent exemption and fees
      const lamportsToSend = Math.max((balanceA * 1_000_000_000) - minBalanceForRentExemption - 25000, 0);

      if (lamportsToSend <= 0) {
        console.log('Not enough balance to cover rent exemption and fees');
        return null;
      }

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.walletAKeypair.publicKey,
          toPubkey: walletBPublicKey,
          lamports: lamportsToSend
        })
      );

      // Get the latest blockhash
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
      if (error.message.includes('block height exceeded')) {
        console.error('Block height exceeded error. Retrying with new blockhash...');
        return this.returnSolToWalletB(walletBPublicKeyString, retryCount);
      } else if (retryCount < 3) {
        console.error('Error returning SOL to Wallet B:', error);
        console.log(`Retrying (${retryCount + 1}/3)...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
        return this.returnSolToWalletB(walletBPublicKeyString, retryCount + 1);
      } else {
        console.error('Max retries reached. Adding to failed transactions queue.');
        await this.addToFailedTransactionsQueue(walletBPublicKeyString);
        throw error;
      }
    }
  }


  async addToFailedTransactionsQueue(walletBPublicKeyString) {
    const failedTransaction = {
      walletBPublicKeyString,
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

      // Trigger processing of failed transactions
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
        // File doesn't exist or is empty
        this.processingFailedTransactions = false;
        return;
      }

      for (let i = 0; i < queue.length; i++) {
        const transaction = queue[i];
        try {
          await this.returnSolToWalletB(transaction.walletBPublicKeyString);
          // If successful, remove from queue
          queue.splice(i, 1);
          i--;
        } catch (error) {
          console.error('Error processing failed transaction:', error);
          transaction.attempts++;
          if (transaction.attempts >= 5) {
            // After 5 attempts, flag for manual intervention
            transaction.requiresManualIntervention = true;
            await this.notifyAdminForManualIntervention(transaction);
          }
        }
      }

      // Update the queue file
      await fs.writeFile(this.failedTransactionsQueue, JSON.stringify(queue, null, 2));
    } catch (err) {
      console.error('Error processing failed transactions:', err);
    } finally {
      this.processingFailedTransactions = false;
    }
  }

  async notifyAdminForManualIntervention(transaction) {
    const message = `URGENT: Manual intervention required for failed transaction.\n` +
      `Wallet B: ${transaction.walletBPublicKeyString}\n` +
      `Attempts: ${transaction.attempts}\n` +
      `First attempt: ${new Date(transaction.timestamp).toISOString()}`;

    // Send notification to admin (e.g., via Telegram or email)
    await this.telegramNotifier.sendTelegramMessage(process.env.ADMIN_CHAT_ID, message);
  }

  async runBalanceCheck(chatId, walletAPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress) {
    try {
      const transaction = await this.getTransactionHistory(walletAPublicKeyString);
      console.log('Transaction:', transaction);

      const walletBPublicKey = transaction.transaction.message.accountKeys.find(
        key => key.toString() !== walletAPublicKeyString && key.toString() !== this.walletAKeypair.publicKey.toString()
      );

      if (!walletBPublicKey) {
        throw new Error('Unable to determine the sender (Wallet B) from the transaction history.');
      }

      const solBalanceA = await this.checkSolBalance(walletAPublicKeyString);
      console.log('Wallet A SOL balance:', solBalanceA);
      let message = MESSAGES.BALANCE_CHECK_REPORT;
      message += MESSAGES.SOL_BALANCE_A(solBalanceA);
      const isSolValid = solBalanceA >= minimumSolBalance;

      const tokenBalanceB = await this.checkTokenBalance(walletBPublicKey.toString(), tokenMintAddress);
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
            walletBPublicKeyString: walletBPublicKey.toString(),
            solBalanceA,
            chatId,
            walletAPrivateKey: bs58.encode(this.walletAKeypair.secretKey)
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

  startPeriodicCheck(chatId, walletAPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress) {
    cron.schedule('*/1 * * * *', async () => {
      console.log('Running periodic balance check...');
      await this.runBalanceCheck(chatId, walletAPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress);
    });

    // Add a separate cron job to process failed transactions
    cron.schedule('*/5 * * * *', async () => {
      console.log('Processing failed transactions...');
      await this.processFailedTransactions();
    });
  }
}

const worker = new Worker('transactionQueue', async job => {
  const { walletBPublicKeyString, solBalanceA, chatId, walletAPrivateKey } = job.data;
  console.log('Worker received walletAPrivateKey:', walletAPrivateKey);

  const balanceChecker = new BalanceChecker(
    [process.env.SOLANA_RPC_ENDPOINT_1, process.env.SOLANA_RPC_ENDPOINT_2],
    new TelegramNotifier(process.env.TELEGRAM_TOKEN),
    walletAPrivateKey
  );

  const signature = await balanceChecker.returnSolToWalletB(walletBPublicKeyString);
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
  await balanceChecker.sendTelegramMessage(job.data.chatId)
});

module.exports = BalanceChecker;