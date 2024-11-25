require('dotenv').config();
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const { MESSAGES } = require('../constants');
const Telegram = require('../Telegram');

const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const KOYNLABS_COMMS = process.env.KOYNLABS_COMMS || 0.2;
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
    const { userKeypair } = userData;
    const senderKeypair = Keypair.fromSecretKey(bs58.decode(userKeypair.privateKey));

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
      console.log(`Commission of ${amountToSend} SOL sent to KoynLabs wallet.`, KOYNLABS_WALLET, senderKeypair.publicKey);
    } catch (error) {
      console.error(`Attempt failed during commission transaction:`, error.message);
      if (retries > 0) {
        console.log(`Retrying... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 seconds before retrying
        return this.sendToCommissionWallet(userData, retries - 1);
      } else {
        console.error('Max retries reached. Commission transaction failed.');
        throw error; // Rethrow the error after max retries
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
}

module.exports = Send;