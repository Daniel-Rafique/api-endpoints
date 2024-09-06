require('dotenv').config()
const bs58 = require('bs58');
const path = require('path');
const os = require('os');
const { Connection, Keypair } = require('@solana/web3.js'); // Import Keypair
const Send = require('./Commission');
const Distribute = require('./Distribute');
const { MESSAGES } = require('../constants');
const DataManager = require('../database');
const { Firestore } = require('@google-cloud/firestore');
const Telegram = require('../Telegram');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const FIRESTORE_KEYSTORE = process.env.FIRESTORE_KEYSTORE;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

class InsufficientBalanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

class Solana {
  constructor() {
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    this.dataManager = new DataManager();
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: path.join(os.homedir(), FIRESTORE_KEYSTORE, '.config/firebaseServiceAccountKey.json'),
    });
    this.telegramNotifier = new Telegram(TELEGRAM_TOKEN);
    this.messageCache = {};
  }

  // Function to handle commission payment
  async handleCommission(chatId, userData) {
    const { walletPk, commissionPaid, walletsCreated } = userData;

    if (!commissionPaid && walletsCreated) {
      try {
        const sendInstance = new Send(chatId);
        await sendInstance.sendToCommissionWallet(userData);
      } catch (error) {
        console.error('Error sending commission:', error);
      }
    } else {
      const senderKeypair = Keypair.fromSecretKey(bs58.decode(walletPk));
      const updatedBalance = await this.connection.getBalance(senderKeypair.publicKey);
      console.log('Commission already paid. Current balance:', updatedBalance);
    }
  }

  // Function to handle Solana distribution
  async handleDistribution(chatId, userData) {
      const { commissionPaid, distributeSolana,  walletPk} = userData;

      const senderKeypair = Keypair.fromSecretKey(bs58.decode(walletPk));
      const updatedBalance = await this.connection.getBalance(senderKeypair.publicKey);

      console.log(`Starting distribution, userData.commissionPaid: ${commissionPaid}, userData.distributeSolana: ${distributeSolana}`);

      if (commissionPaid && !distributeSolana && updatedBalance > 0) {
        console.log(`distribution in Progress, commissionPaid: ${commissionPaid}, userData.distributeSolana: ${distributeSolana}`);

        try {
          const distributeInstance = new Distribute(chatId);
          const results = await distributeInstance.distributeSolana(chatId, userData, updatedBalance);
          console.log('Distribution results:', results);
          const message = MESSAGES.DEPLOYMENT(updatedBalance);
          if (this.shouldSendMessage(chatId, message)) {
            await this.telegramNotifier.sendTelegramMessage(chatId, message);
          }
        } catch (error) {
          console.error('Error updating distributeSolana flag:', error);
        }

      } else if (updatedBalance <= 0) {
        console.log('No balance left to distribute.');
        // Set commission paid to false and distributeSolana to false to allow for top-ups
        await this.firestore.collection(FIRESTORE_COLLECTION)
          .doc(chatId.toString())
          .update({ distributeSolana: false, commissionPaid: false });
      }
    }

    shouldSendMessage(chatId, message) {
      const cacheKey = chatId;
      const currentTime = Date.now();
      const cacheDuration = 60 * 10000; // 10 minutes

      console.log(`Checking message cache for chatId: ${chatId}`);
      console.log(`Current message: ${message}`);
      console.log(`Message cache:`, this.messageCache);

      if (!this.messageCache[cacheKey]) {
        console.log('No cached message found, sending message.');
        this.messageCache[cacheKey] = { message, timestamp: currentTime };
        return true;
      }

      const { message: cachedMessage, timestamp } = this.messageCache[cacheKey];

      if (message === cachedMessage && currentTime - timestamp < cacheDuration) {
        console.log('Duplicate message detected, not sending.');
        return false;
      }

      console.log('Message cache expired or different message, sending message.');
      this.messageCache[cacheKey] = { message, timestamp: currentTime };
      return true;
    }
  }

module.exports = Solana;