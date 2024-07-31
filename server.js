require('dotenv').config();
const bs58 = require('bs58');
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const cron = require('node-cron');
const { Queue, Worker } = require('bullmq');
const { MESSAGES } = require('../constants');
const DataManager = require('../database');
const TelegramNotifier = require('../TelegramNotifier');
const { escapeMarkdown } = require('../utils');

const redisOptions = {
  host: 'localhost', // Replace with your Redis host
  port: 6379, // Replace with your Redis port
};

const transactionQueue = new Queue('transactionQueue', { connection: redisOptions });

class BalanceChecker {
  constructor(rpcEndpoints, telegramNotifier, walletAPrivateKey) {
    this.rpcEndpoints = rpcEndpoints;
    this.currentRpcIndex = 0;
    this.connection = new Connection(this.rpcEndpoints[this.currentRpcIndex], 'confirmed');
    this.telegramNotifier = telegramNotifier;
    this.dataManager = new DataManager();
    this.walletAKeypair = Keypair.fromSecretKey(bs58.decode(walletAPrivateKey));
  }

  switchRpcEndpoint() {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcEndpoints.length;
    this.connection = new Connection(this.rpcEndpoints[this.currentRpcIndex], 'confirmed');
  }

  async checkSolBalance(publicKeyString) {
    try {
      const publicKey = new PublicKey(publicKeyString);
      const balance = await this.connection.getBalance(publicKey);
      const solBalance = balance / 1_000_000_000; // Convert lamports to SOL
      return solBalance;
    } catch (error) {
      console.error('Error checking SOL balance:', error);
      this.switchRpcEndpoint();
      throw error;
    }
  }

  async checkTokenBalance(publicKeyString, tokenMint) {
    try {
      const publicKey = new PublicKey(publicKeyString);
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
      });

      const tokenAccount = tokenAccounts.value.find(
        account => account.account.data.parsed.info.mint === tokenMint
      );

      if (tokenAccount) {
        return tokenAccount.account.data.parsed.info.tokenAmount.uiAmount;
      }
      return 0;
    } catch (error) {
      console.error('Error checking token balance:', error);
      this.switchRpcEndpoint();
      throw error;
    }
  }

  async sendTelegramMessage(chatId, text) {
    await this.telegramNotifier.sendTelegramMessage(chatId, text);
  }

  async getTransactionHistory(walletAPublicKey) {
    try {
      const signatures = await this.connection.getSignaturesForAddress(new PublicKey(walletAPublicKey), { limit: 1 });
      const confirmedTransaction = await this.connection.getTransaction(signatures[0].signature);
      return confirmedTransaction;
    } catch (error) {
      console.error('Error fetching transaction history:', error);
      this.switchRpcEndpoint();
      throw error;
    }
  }

  async returnSolToWalletB(walletBPublicKeyString) {
    try {
      const walletBPublicKey = new PublicKey(walletBPublicKeyString);
      const balanceA = await this.checkSolBalance(this.walletAKeypair.publicKey.toBase58());

      // Subtract a small amount to cover the transaction fee
      const lamportsToSend = (balanceA * 1_000_000_000) - 5000; // Leave some lamports for fees
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.walletAKeypair.publicKey,
          toPubkey: walletBPublicKey,
          lamports: lamportsToSend
        })
      );

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.walletAKeypair]
      );

      console.log('Transaction signature:', signature);

      return signature;
    } catch (error) {
      console.error('Error returning SOL to Wallet B:', error);
      this.switchRpcEndpoint();
      throw error;
    }
  }

  async runBalanceCheck(chatId, walletAPublicKey, minimumSol, minimumToken, tokenMint) {
    try {
      const transaction = await this.getTransactionHistory(walletAPublicKey);
      const walletBPublicKey = transaction.transaction.message.accountKeys.find(
        key => key.toString() !== walletAPublicKey.toString() && key.toString() !== this.walletAKeypair.publicKey.toString()
      );

      if (!walletBPublicKey) {
        throw new Error('Unable to determine the sender (Wallet B) from the transaction history.');
      }

      // Check SOL balance of Wallet A
      const solBalanceA = await this.checkSolBalance(walletAPublicKey);
      let message = MESSAGES.BALANCE_CHECK_REPORT;
      message += MESSAGES.SOL_BALANCE_A(solBalanceA);
      const isSolValid = solBalanceA >= minimumSol;

      // Check Token balance of Wallet B
      const tokenBalanceB = await this.checkTokenBalance(walletBPublicKey, tokenMint);
      message += MESSAGES.TOKEN_BALANCE_B(tokenBalanceB);
      const isTokenValid = tokenBalanceB >= minimumToken;

      if (isSolValid && isTokenValid) {
        message += MESSAGES.SUFFICIENT_BALANCE;
      } else {
        if (!isSolValid) {
          message += MESSAGES.INSUFFICIENT_SOL(minimumSol);
        }
        if (!isTokenValid) {
          message += MESSAGES.INSUFFICIENT_TOKEN(minimumToken);
        }
        if (!isSolValid || !isTokenValid) {
          console.log('Returning SOL to Wallet B:', solBalanceA);
          if (solBalanceA > 0) {
            await transactionQueue.add('returnSol', { walletBPublicKeyString: walletBPublicKey, solBalanceA, chatId, walletAPrivateKey: this.walletAKeypair.secretKey });
            message += MESSAGES.RETURNED_SOL(solBalanceA, '(pending)');
          } else {
            console.log('SOL balance is 0, not returning funds.');
          }
        }
      }

      await this.sendTelegramMessage(chatId, message);
    } catch (error) {
      console.error('Error during balance check:', error);
      await this.sendTelegramMessage(chatId, MESSAGES.ERROR_DURING_CHECK(error.message));
    }
  }

  startPeriodicCheck(chatId, walletAPublicKey, minimumSol, minimumToken, tokenMint) {
    cron.schedule('*/1 * * * *', async () => {
      console.log('Running periodic balance check...');
      await this.runBalanceCheck(chatId, walletAPublicKey, minimumSol, minimumToken, tokenMint);
    });
  }
}

// Worker to process the transaction queue
const worker = new Worker('transactionQueue', async job => {
  const { walletBPublicKeyString, solBalanceA, chatId, walletAPrivateKey } = job.data;
  const balanceChecker = new BalanceChecker(
    [process.env.SOLANA_RPC_ENDPOINT_1, process.env.SOLANA_RPC_ENDPOINT_2],
    new TelegramNotifier(process.env.TELEGRAM_TOKEN),
    walletAPrivateKey
  );
  const signature = await balanceChecker.returnSolToWalletB(walletBPublicKeyString);
  return { signature, chatId, solBalanceA };
}, { connection: redisOptions });

worker.on('completed', async (job, result) => {
  console.log(`Transaction job completed: ${job.id}, signature: ${result.signature}`);
  const message = MESSAGES.RETURNED_SOL(result.solBalanceA, result.signature);
  const balanceChecker = new BalanceChecker(
    [process.env.SOLANA_RPC_ENDPOINT_1, process.env.SOLANA_RPC_ENDPOINT_2],
    new TelegramNotifier(process.env.TELEGRAM_TOKEN),
    result.walletAPrivateKey
  );
  await balanceChecker.sendTelegramMessage(result.chatId, message);
});

worker.on('failed', (job, err) => {
  console.error(`Transaction job failed: ${job.id}`, err);
});

module.exports = BalanceChecker;
