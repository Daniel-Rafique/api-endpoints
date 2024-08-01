require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const bs58 = require('bs58');
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

const isValidPublicKey = (key) => {
  try {
    const decoded = bs58.decode(key);
    console.log('Decoded length:', decoded.length); // Should be 32
    return decoded.length === 32;
  } catch (error) {
    console.error('Error decoding key:', error);
    return false;
  }
};

class BalanceChecker {
  constructor(rpcEndpoints, telegramNotifier, walletAPrivateKey) {
    console.log('Wallet A Private Key:', walletAPrivateKey);
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

  async checkTokenBalance(walletPublicKeyString, tokenMintAddress) {
    try {
      console.log('Checking token balance...');
      console.log('Wallet Public Key:', walletPublicKeyString);
      console.log('Token Mint Address:', tokenMintAddress);

      if (!isValidPublicKey(walletPublicKeyString)) {
        throw new Error(`Invalid public key input: ${walletPublicKeyString}`);
      }

      if (!isValidPublicKey(tokenMintAddress)) {
        throw new Error(`Invalid token mint address input: ${tokenMintAddress}`);
      }

      // Use the connection from the class instance
      const { connection } = this;

      // Convert the public key string to a PublicKey object
      const publicKey = new PublicKey(walletPublicKeyString);
      console.log('Public Key object created:', publicKey.toString());

      // Get the associated token address for the SPL token
      const associatedTokenAddress = await splToken.getAssociatedTokenAddress(
        splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
        splToken.TOKEN_PROGRAM_ID,
        new PublicKey(tokenMintAddress),
        publicKey
      );

      console.log('Associated Token Address:', associatedTokenAddress.toString());

      // Fetch the token account balance
      const tokenAccountInfo = await connection.getParsedAccountInfo(associatedTokenAddress);

      // Check if the account exists and get the balance
      let tokenBalance = 0;
      if (tokenAccountInfo.value) {
        const tokenAmount = tokenAccountInfo.value.data.parsed.info.tokenAmount;
        tokenBalance = tokenAmount.uiAmount;
        console.log('Token Amount:', tokenAmount);
      } else {
        console.log('Token account does not exist or no data found.');
      }

      console.log('Token Balance: ', tokenBalance);
      return tokenBalance;
    } catch (error) {
      console.error('Error checking token balance:', error);
      this.switchRpcEndpoint();
      throw error;
    }
  }

  async sendTelegramMessage(chatId, text) {
    await this.telegramNotifier.sendTelegramMessage(chatId, text);
  }

  async getTransactionHistory(walletAPublicKeyString) {
    try {
      const walletAPublicKey = new PublicKey(walletAPublicKeyString);
      console.log('Wallet A Public Key:', walletAPublicKey.toString());
      const signatures = await this.connection.getSignaturesForAddress(walletAPublicKey, { limit: 1 });
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

      // Check SOL balance of Wallet A
      const solBalanceA = await this.checkSolBalance(walletAPublicKeyString);
      console.log('Wallet A SOL balance:', solBalanceA);
      let message = MESSAGES.BALANCE_CHECK_REPORT;
      message += MESSAGES.SOL_BALANCE_A(solBalanceA);
      const isSolValid = solBalanceA >= minimumSolBalance;

      // Check Token balance of Wallet B
      const tokenBalanceB = await this.checkTokenBalance(walletBPublicKey.toString(), tokenMintAddress);
      console.log('Wallet B Token balance:', tokenBalanceB);

      message += MESSAGES.TOKEN_BALANCE_B(tokenBalanceB);
      const isTokenValid = tokenBalanceB >= minimumTokenBalance;

      console.log('SOL balance:', solBalanceA, 'Token balance:', tokenBalanceB);

      if (isSolValid && isTokenValid) {
        message += MESSAGES.SUFFICIENT_BALANCE;
      } else {
        if (!isSolValid) {
          message += MESSAGES.INSUFFICIENT_SOL(minimumSolBalance);
        }
        if (!isTokenValid) {
          message += MESSAGES.INSUFFICIENT_TOKEN(minimumTokenBalance);
        }
        if (!isSolValid || !isTokenValid) {
          console.log('Returning SOL to Wallet B:', solBalanceA);
          if (solBalanceA > 0) {
            await transactionQueue.add('returnSol', { walletBPublicKeyString: walletBPublicKey.toString(), solBalanceA, chatId, walletAPrivateKey: bs58.encode(this.walletAKeypair.secretKey) });
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

  startPeriodicCheck(chatId, walletAPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress) {
    cron.schedule('*/1 * * * *', async () => {
      console.log('Running periodic balance check...');
      await this.runBalanceCheck(chatId, walletAPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress);
    });
  }
}

// Worker to process the transaction queue
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