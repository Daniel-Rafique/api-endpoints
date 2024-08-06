require('dotenv').config();
const { Connection, Keypair } = require('@solana/web3.js');
const Send = require('./Send');
const Distribute = require('./Distribute');
const { MESSAGES } = require('../constants');
const DataManager = require('../database');
const Firestore = require('@google-cloud/firestore');
const InstanceInitializer = require('../InstanceInitializer');
const Telegram = require('../Telegram');

const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_2;
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
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
      keyFilename: '.config/firebaseServiceAccountKey.json',
    });
    this.instanceInitializer = new InstanceInitializer();
    this.telegramNotifier = new Telegram(TELEGRAM_TOKEN);
    this.messageCache = {}; // Initialize cache for messages
  }

  async distributeSolana(chatId) {
    try {
      const userData = await this.dataManager.getCollection(chatId.toString());

      if (!userData || !userData.walletPk) {
        throw new Error('User data or wallet private key not found');
      }

      const sendInstance = new Send();
      const updatedBalance = await sendInstance.sendToKoynlabsWallet(userData.walletPk);

      if (updatedBalance > 0) {
        const distributeInstance = new Distribute();
        const results = await distributeInstance.distributeSolana(userData.walletPk, chatId);
        console.log('Distribution results:', results);
      } else {
        console.log('No balance left to distribute.');
        const userDocRef = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatId.toString());
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) {
          throw new Error('User document does not exist');
        }
        await userDocRef.update({ distributeSolana: true });
        if (!userData.instancesCreated) {
          await this.instanceInitializer.initializeMarketMakerInstance(chatId);
          const message = MESSAGES.DEPLOYMENT;
          if (this.shouldSendMessage(chatId, message)) {
            await this.telegramNotifier.sendTelegramMessage(chatId, message);
          }
        }
      }
    } catch (error) {
      console.error('Error during airdrop:', error);
      if (error instanceof InsufficientBalanceError) {
        console.log('Wallet is empty:', error.message);
        const message = MESSAGES.TOPUP_SOL(userData.boostCost || 0);
        if (this.shouldSendMessage(chatId, message)) {
          await this.telegramNotifier.sendTelegramMessage(chatId, message);
        }
      } else {
        console.log(error.message);
      }
    }
  }

  shouldSendMessage(chatId, message) {
    const cacheKey = chatId;
    const currentTime = Date.now();
    const cacheDuration = 60 * 1000; // 1 minute

    if (!this.messageCache[cacheKey]) {
      this.messageCache[cacheKey] = { message, timestamp: currentTime };
      return true;
    }

    const { message: cachedMessage, timestamp } = this.messageCache[cacheKey];

    if (message === cachedMessage && currentTime - timestamp < cacheDuration) {
      return false;
    }

    this.messageCache[cacheKey] = { message, timestamp: currentTime };
    return true;
  }
}

module.exports = Solana;