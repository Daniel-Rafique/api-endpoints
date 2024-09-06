require('dotenv').config();
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const { MESSAGES } = require('../constants');
const Telegram = require('../Telegram');

const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const KOYNLABS_COMMS = process.env.KOYNLABS_COMMS || 0.3;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

class InsufficientBalanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

class Send {
  constructor(chatId) {
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    this.chatId = chatId;
    this.telegramNotifier = new Telegram(TELEGRAM_TOKEN);
    this.messageCache = {}; // Initialize cache for messages
  }

  async sendToCommissionWallet(userData) {
    const { walletPk } = userData;
    const senderKeypair = Keypair.fromSecretKey(bs58.decode(walletPk));
    const retryLimit = 3;
  
    for (let attempt = 0; attempt < retryLimit; attempt++) {
      try {
        const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);
  
        if (senderBalance <= 0) {
          throw new InsufficientBalanceError('Insufficient balance in sender wallet');
        }
  
        const amountToSend = Math.floor(senderBalance * KOYNLABS_COMMS);
        const estimatedFee = await this.getEstimatedFee(senderKeypair);
        const remainingBalance = senderBalance - amountToSend - estimatedFee;
  
        if (remainingBalance < 0) {
          throw new InsufficientBalanceError('Insufficient balance to pay commission and cover fees.');
        }
  
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: senderKeypair.publicKey,
            toPubkey: new PublicKey(KOYNLABS_WALLET),
            lamports: amountToSend,
          })
        );
  
        transaction.feePayer = senderKeypair.publicKey;
        transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
        transaction.sign(senderKeypair);
  
        await sendAndConfirmTransaction(this.connection, transaction, [senderKeypair]);
  
      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed during commission transaction:`, error.message);
        if (attempt === retryLimit - 1) throw error; // If it's the last attempt, throw the error
      }
    }
  }

  async getEstimatedFee(senderKeypair) {
    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new Transaction({
      recentBlockhash: blockhash,
      feePayer: senderKeypair.publicKey
    }).add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: senderKeypair.publicKey, // Dummy transfer to self
        lamports: 1
      })
    ).compileMessage();
    const { value } = await this.connection.getFeeForMessage(message);
    return value;
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

module.exports = Send;