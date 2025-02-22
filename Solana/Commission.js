require('dotenv').config();
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const { MESSAGES } = require('../constants');
const Telegram = require('../Telegram');
const Discord = require('../Discord');

const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const KOYNLABS_COMMS = process.env.KOYNLABS_COMMS || 0.2;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_1;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

class InsufficientBalanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

class Commission {
  constructor(chatId) {
    if (!chatId) {
      throw new Error('ChatId is required');
    }

    this.connection = new Connection(SOLANA_RPC_ENDPOINT, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
      wsEndpoint: process.env.SOLANA_WEBSOCKET
    });

    this.chatId = chatId;
    this.telegramNotifier = new Telegram(TELEGRAM_TOKEN);
    this.discordNotifier = new Discord();
    this.messageCache = new Map();

    if (!KOYNLABS_WALLET || !KOYNLABS_COMMS) {
      throw new Error('Missing required environment variables');
    }
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

  async sendToCommissionWallet(userData, retries = 3) {
    if (!userData?.userKeypair?.privateKey) {
      throw new Error('Invalid user data or missing keypair');
    }

    const senderKeypair = Keypair.fromSecretKey(bs58.decode(userData.userKeypair.privateKey));
    const commissionRate = parseFloat(KOYNLABS_COMMS);

    try {
      const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);
      console.log(`Initial balance: ${senderBalance / 1e9} SOL`);

      if (senderBalance <= 0) {
        throw new InsufficientBalanceError('Insufficient balance in sender wallet');
      }

      const amountToSend = Math.floor(senderBalance * commissionRate);
      console.log(`Commission amount: ${amountToSend / 1e9} SOL (${commissionRate * 100}%)`);

      const estimatedFee = await this.getEstimatedFee(senderKeypair);
      console.log(`Estimated fee: ${estimatedFee / 1e9} SOL`);

      const remainingBalance = senderBalance - amountToSend - estimatedFee;
      if (remainingBalance < 0) {
        throw new InsufficientBalanceError(
          `Insufficient balance to pay commission and cover fees. ` +
          `Required: ${((amountToSend + estimatedFee) / 1e9).toFixed(4)} SOL, ` +
          `Available: ${(senderBalance / 1e9).toFixed(4)} SOL`
        );
      }

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: senderKeypair.publicKey,
          toPubkey: new PublicKey(KOYNLABS_WALLET),
          lamports: amountToSend,
        })
      );

      transaction.feePayer = senderKeypair.publicKey;
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.sign(senderKeypair);

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [senderKeypair],
        {
          skipPreflight: false,
          commitment: 'confirmed',
          maxRetries: 3
        }
      );

      const confirmation = await this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      });

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      console.log(`Commission transaction successful:
        Amount: ${amountToSend / 1e9} SOL
        From: ${senderKeypair.publicKey.toString()}
        To: ${KOYNLABS_WALLET}
        Signature: ${signature}
      `);

      await this.sendNotification(
        userData,
        `✅ Commission payment successful: ${amountToSend / 1e9} SOL`
      );

      return signature;

    } catch (error) {
      console.error(`Commission transaction failed:`, error);

      if (retries > 0) {
        console.log(`Retrying... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, 2000 * (4 - retries)));
        return this.sendToCommissionWallet(userData, retries - 1);
      }

      await this.sendNotification(
        userData,
        `❌ Commission payment failed: ${error.message}`
      );

      throw error;
    }
  }

  async getEstimatedFee(senderKeypair) {
    try {
      const { blockhash } = await this.connection.getLatestBlockhash();
      const message = new Transaction({
        recentBlockhash: blockhash,
        feePayer: senderKeypair.publicKey
      }).add(
        SystemProgram.transfer({
          fromPubkey: senderKeypair.publicKey,
          toPubkey: new PublicKey(KOYNLABS_WALLET),
          lamports: 1
        })
      ).compileMessage();

      const { value: fee } = await this.connection.getFeeForMessage(message);
      return fee * 1.5;
    } catch (error) {
      console.error('Error estimating fee:', error);
      throw error;
    }
  }
}

module.exports = Commission;