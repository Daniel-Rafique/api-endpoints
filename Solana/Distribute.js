const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const bs58 = require('bs58');
const { MESSAGES } = require('../constants');
const Telegram = require('../Telegram');
const { Firestore } = require('@google-cloud/firestore');

const redis = require('redis');
const client = redis.createClient();

client.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  await client.connect();
})();

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
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
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    this.chatId = chatId;
    this.telegramNotifier = new Telegram(TELEGRAM_TOKEN);
    this.messageCache = {}; // Initialize cache for messages
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: path.join(os.homedir(), FIRESTORE_KEYSTORE, '.config/firebaseServiceAccountKey.json'), // Corrected path
    });
  }

  async distributeSolana(senderPrivateKey, chatId, userData) {
    try {
      const userDocRef = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatId.toString());
      const senderKeypair = Keypair.fromSecretKey(bs58.decode(senderPrivateKey));
      const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);

      if (senderBalance <= 0) {
        throw new InsufficientBalanceError('Insufficient balance in sender wallet');
      }

      // Resolve the file path
      const filePath = path.resolve(os.homedir(), ENV_PATH, `instances/${chatId}/dist/wallets.json`);

      // Wait for the wallets.json file to be created if it doesn't exist
      await this.waitForFile(filePath);

      // Read the wallets.json file
      const fileContent = await fs.readFile(filePath, 'utf8');
      const newWallets = JSON.parse(fileContent);

      // Remaining balance logic
      const remainingBalance = senderBalance;
      if (!userData.makers || userData.makers <= 0) {
        throw new Error('Invalid number of makers.');
      }
      const amountPerWallet = Math.round(remainingBalance / userData.makers);

      if (isNaN(amountPerWallet) || amountPerWallet <= 0) {
        throw new InsufficientBalanceError('Insufficient balance to distribute SOL.');
      }

      const dropList = newWallets.map(wallet => ({
        walletAddress: wallet.publicKey,
        numLamports: amountPerWallet,
      }));

      await userDocRef.update({ distributeSolana: true });
      const transactionList = this.generateTransactions(dropList, senderKeypair.publicKey, userData);
      const txResults = await this.executeTransactions(transactionList, senderKeypair, userData);
      await userDocRef.update({ distributeSolana: false, commissionPaid: false });
      return txResults;
    } catch (error) {
      console.error('Error during distribution:', error);
      if (error instanceof InsufficientBalanceError) {
        console.log('Wallet is empty:', error.message);
        const message = MESSAGES.TOPUP_SOL(userData.boostCost || 0);
        if (this.shouldSendMessage(this.chatId, message)) {
          await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
        }
      } else {
        throw error;
      }
    }
  }

  // Wait for the file to exist
  async waitForFile(filePath) {
    while (true) {
      try {
        await fs.access(filePath);
        break; // File exists, break out of loop
      } catch (err) {
        console.log(`Waiting for file to be created: ${filePath}`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before retrying
      }
    }
  }

  generateTransactions(dropList, fromWallet, userData) {
    const transactions = [];
    const txInstructions = dropList.map(drop =>
      SystemProgram.transfer({
        fromPubkey: fromWallet,
        toPubkey: new PublicKey(drop.walletAddress),
        lamports: drop.numLamports,
      })
    );

    const batchSize = Math.round(txInstructions.length / userData.makers);
    const numTransactions = Math.round(txInstructions.length / batchSize);
    for (let i = 0; i < numTransactions; i++) {
      const transaction = new Transaction();
      const lowerIndex = i * batchSize;
      const upperIndex = (i + 1) * batchSize;
      for (let j = lowerIndex; j < upperIndex; j++) {
        if (txInstructions[j]) transaction.add(txInstructions[j]);
      }
      transactions.push(transaction);
    }
    return transactions;
  }

  async executeTransactions(transactionList, payer, userData) {
    const results = [];
    const staggeredTransactions = transactionList.map((transaction, i) => {
      return new Promise((resolve) => {
        setTimeout(async () => {
          try {
            console.log(`Requesting Transaction ${i + 1}/${userData.makers}`);
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            const signature = await sendAndConfirmTransaction(this.connection, transaction, [payer]);
            resolve({ status: 'fulfilled', signature });
          } catch (error) {
            resolve({ status: 'rejected', reason: error.message });
          }
        }, i * TX_INTERVAL);
      });
    });

    results.push(...await Promise.allSettled(staggeredTransactions));
    return results;
  }

  async shouldSendMessage(chatId, message) {
    const cacheKey = chatId;
    const currentTime = Date.now();
    const cacheDuration = 600; // 10 minutes in seconds

    console.log(`Checking message cache for chatId: ${chatId}`);
    console.log(`Current message: ${message}`);

    const cachedMessage = await client.get(cacheKey);

    if (cachedMessage) {
      const { message: cachedMsg, timestamp } = JSON.parse(cachedMessage);
      if (message === cachedMsg && currentTime - timestamp < cacheDuration * 1000) {
        console.log('Duplicate message detected, not sending.');
        return false;
      }
    }

    console.log('No cached message found or cache expired, sending message.');
    await client.set(cacheKey, JSON.stringify({ message, timestamp: currentTime }), {
      EX: cacheDuration,
    });

    return true;
  }
} // Add this closing parenthesis

module.exports = Distribute;