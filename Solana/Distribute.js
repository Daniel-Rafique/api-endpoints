require('dotenv').config();
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const bs58 = require('bs58');
const { MESSAGES } = require('../constants');
const Telegram = require('../Telegram');
const { Firestore } = require('@google-cloud/firestore');
const Discord = require('../Discord');

const redis = require('redis');
const client = redis.createClient();

client.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  await client.connect();
})();

const FIRESTORE_KEYSTORE = process.env.FIRESTORE_KEYSTORE;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT;
const TX_INTERVAL = 1000;
const ENV_PATH = process.env.ENV_PATH;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

class InsufficientBalanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

class Distribute {
  constructor(chatId) {
    this.chatId = chatId;
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
      wsEndpoint: process.env.SOLANA_WEBSOCKET
    });
    this.telegramNotifier = new Telegram(TELEGRAM_TOKEN);
    this.discordNotifier = new Discord();
    this.messageCache = new Map();
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: path.join(os.homedir(), FIRESTORE_KEYSTORE, '.config/firebaseServiceAccountKey.json'),
    });
  }

  async sendNotification(userData, message) {
    try {
      if (userData.platform === 'discord') {
        await this.discordNotifier.sendMessage(this.chatId, message);
      } else {
        await this.telegramNotifier.sendMessage(this.chatId, message);
      }
    } catch (error) {
      console.error(`Failed to send notification: ${error.message}`);
    }
  }

  async distributeSolana(chatId, userData) {
    if (!chatId || !userData) {
      throw new Error('Missing required parameters');
    }

    const { batchSize, makers, userKeypair } = userData;
    const retryLimit = 3;
    let attempt = 0;

    const updatedBalance = await this.connection.getBalance(userKeypair.publicKey);
    console.log(`Initial balance: ${updatedBalance / 1e9} SOL`);

    if (updatedBalance <= 0) {
      throw new InsufficientBalanceError('Insufficient balance in sender wallet');
    }

    while (attempt < retryLimit) {
      try {
        const senderKeypair = Keypair.fromSecretKey(bs58.decode(userKeypair.privateKey));
        const filePath = path.resolve(os.homedir(), ENV_PATH, `instances/${chatId}/dist/wallets.json`);

        await this.waitForFile(filePath, 30000);

        const fileContent = await fs.readFile(filePath, 'utf8');
        const newWallets = JSON.parse(fileContent);

        if (newWallets.length > 1000) {
          throw new Error('Maximum wallet limit exceeded (1000)');
        }

        const amountPerWallet = Math.floor(updatedBalance / makers);
        console.log(`Amount per wallet: ${amountPerWallet / 1e9} SOL`);

        if (amountPerWallet < 1000000) {
          throw new InsufficientBalanceError('Amount per wallet too low');
        }

        const totalBatches = Math.ceil(newWallets.length / batchSize);
        for (let i = 0; i < newWallets.length; i += batchSize) {
          const currentBatch = Math.floor(i / batchSize) + 1;
          console.log(`Processing batch ${currentBatch}/${totalBatches}`);

          const chunk = newWallets.slice(i, i + batchSize);
          const dropList = chunk.map(wallet => ({
            walletAddress: wallet.publicKey,
            numLamports: amountPerWallet,
          }));

          const transactionList = this.generateTransactions(dropList, senderKeypair.publicKey, userData);
          const results = await this.executeTransactions(transactionList, senderKeypair, userData);

          this.logTransactionResults(results, currentBatch, userData);
        }

        console.log('Distribution completed successfully');
        await this.sendNotification(
          userData,
          `✅ Distribution completed successfully\n` +
          `Total wallets: ${newWallets.length}\n` +
          `Amount per wallet: ${amountPerWallet / 1e9} SOL`
        );

        return true;

      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed:`, error);
        if (attempt === retryLimit - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
      attempt++;
    }
  }

  async waitForFile(filePath, timeout) {
    const startTime = Date.now();
    while (true) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Timeout waiting for file: ${filePath}`);
      }
      try {
        await fs.access(filePath);
        return;
      } catch (err) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  generateTransactions(dropList, fromWallet, userData) {
    if (!dropList?.length || !fromWallet || !userData?.makers) {
      throw new Error('Invalid parameters for transaction generation');
    }

    const transactions = [];
    const txInstructions = dropList.map(drop => {
      try {
        return SystemProgram.transfer({
          fromPubkey: fromWallet,
          toPubkey: new PublicKey(drop.walletAddress),
          lamports: drop.numLamports,
        });
      } catch (error) {
        console.error(`Invalid wallet address: ${drop.walletAddress}`);
        throw error;
      }
    });

    const batchSize = Math.max(1, Math.floor(txInstructions.length / userData.makers));
    const numTransactions = Math.ceil(txInstructions.length / batchSize);

    for (let i = 0; i < numTransactions; i++) {
      const transaction = new Transaction();
      const batch = txInstructions.slice(i * batchSize, (i + 1) * batchSize);
      batch.forEach(instruction => transaction.add(instruction));
      transactions.push(transaction);
    }

    return transactions;
  }

  async logTransactionResults(results, batchNumber, userData) {
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    const message = `Batch ${batchNumber} results: ` +
      `✅ ${successful} successful, ❌ ${failed} failed`;

    console.log(message);
    await this.sendNotification(userData, message);

    if (failed > 0) {
      results
        .filter(r => r.status === 'rejected')
        .forEach((r, i) => console.error(`Transaction ${i} failed:`, r.reason));
    }
  }
}

module.exports = Distribute;