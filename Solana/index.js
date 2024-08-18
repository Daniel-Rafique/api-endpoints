require('dotenv').config()
const bs58 = require('bs58');
const path = require('path');
const os = require('os');
const { Connection, Keypair } = require('@solana/web3.js'); // Import Keypair
const Send = require('./Send');
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
      keyFilename: path.join(os.homedir(),
        FIRESTORE_KEYSTORE,
        '.config/firebaseServiceAccountKey.json'),
    });
    this.telegramNotifier = new Telegram(TELEGRAM_TOKEN);
    this.messageCache = {}; // Initialize cache for messages
  }

  async distributeSolana(chatId) {
    try {
        const userData = await this.dataManager.getCollection(chatId.toString());

        if (!userData || !userData.walletPk) {
            throw new Error('User data or wallet private key not found');
        }

        let updatedBalance;

        const sendInstance = new Send(chatId);

        if (!userData.commissionPaid) {
            updatedBalance = await sendInstance.sendToKoynlabsWallet(userData.walletPk, userData);
            // Mark the commission as paid
            await this.firestore.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).update({ commissionPaid: true });
        } else {
            const senderKeypair = Keypair.fromSecretKey(bs58.decode(userData.walletPk));
            updatedBalance = await this.connection.getBalance(senderKeypair.publicKey);
        }

        // After sending the commission, proceed to distribute the remaining Solana if there is a balance left
        if (updatedBalance > 0) {
            const distributeInstance = new Distribute(chatId);
            const results = await distributeInstance.distributeSolana(userData.walletPk, chatId, userData);
            console.log('Distribution results:', results);

            const message = MESSAGES.DEPLOYMENT(updatedBalance);
            if (this.shouldSendMessage(chatId, message)) {
                await this.telegramNotifier.sendTelegramMessage(chatId, message);
            }
        } else {
            console.log('No balance left to distribute.');
            const userDocRef = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatId.toString());
            const userDoc = await userDocRef.get();
            if (!userDoc.exists) {
                throw new Error('User document does not exist');
            }
            await userDocRef.update({ distributeSolana: false });
        }
    } catch (error) {
        console.error('Error during airdrop:', error);
        if (error instanceof InsufficientBalanceError) {
            console.log('Wallet is empty:', error.message);
            const message = MESSAGES.TOPUP_SOL(userData.boostCost);
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