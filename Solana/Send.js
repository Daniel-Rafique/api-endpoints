require('dotenv').config();
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const { MESSAGES } = require('../constants');
const Telegram = require('../Telegram');

const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const KOYNLABS_COMMS = process.env.KOYNLABS_COMMS || 0.3;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_2;
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

  async sendToKoynlabsWallet(senderPrivateKey, userData) {
    try {
      const senderKeypair = Keypair.fromSecretKey(bs58.decode(senderPrivateKey));
      const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);

      if (senderBalance <= 0) {
        throw new InsufficientBalanceError('Insufficient balance in sender wallet');
      }

      const amountToSend = Math.floor(senderBalance * parseInt(KOYNLABS_COMMS));
      const estimatedFee = await this.getEstimatedFee(senderKeypair);

      console.log('About to send to koynlabs', amountToSend)

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: senderKeypair.publicKey,
          toPubkey: new PublicKey(KOYNLABS_WALLET),
          lamports: amountToSend - estimatedFee,
        })
      );

      transaction.feePayer = senderKeypair.publicKey;
      transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
      transaction.sign(senderKeypair);

      await sendAndConfirmTransaction(this.connection, transaction, [senderKeypair]);

      const updatedBalance = await this.connection.getBalance(senderKeypair.publicKey);
      return updatedBalance;
    } catch (error) {
      console.error('Error during airdrop:', error);
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
}

module.exports = Send;