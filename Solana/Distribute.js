require('dotenv').config();
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
    const retryLimit = 3;
    let attempt = 0;

    while (attempt < retryLimit) {
        try {
            const senderKeypair = Keypair.fromSecretKey(bs58.decode(senderPrivateKey));
            const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);

            if (senderBalance <= 0) {
                throw new InsufficientBalanceError('Insufficient balance in sender wallet');
            }

            const filePath = path.resolve(os.homedir(), ENV_PATH, `instances/${chatId}/dist/wallets.json`);
            await this.waitForFile(filePath);
            const fileContent = await fs.readFile(filePath, 'utf8');
            const newWallets = JSON.parse(fileContent);

            const amountPerWallet = Math.floor(senderBalance / userData.makers);
            if (isNaN(amountPerWallet) || amountPerWallet <= 0) {
                throw new InsufficientBalanceError('Insufficient balance to distribute SOL.');
            }

            const dropList = newWallets.map(wallet => ({
                walletAddress: wallet.publicKey,
                numLamports: amountPerWallet,
            }));

            const transactionList = this.generateTransactions(dropList, senderKeypair.publicKey, userData);
            const txResults = await this.executeTransactions(transactionList, senderKeypair, userData);

            return txResults;
        } catch (error) {
            console.error(`Attempt ${attempt + 1} failed during distribution:`, error.message);
            if (attempt === retryLimit - 1) throw error; // If it's the last attempt, throw the error
        }
        attempt++;
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
  async retryOperation(operation, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed: ${error.message}`);
        if (attempt === retries - 1) throw error; // Throw the error if it's the last attempt
      }
    }
  }
}

module.exports = Distribute;