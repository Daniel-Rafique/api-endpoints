require('dotenv').config();
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const Encryption = require('../utils/encryption');
const { MESSAGES } = require('../constants');
const Telegram = require('../Telegram');
const Discord = require('../Discord');

const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const KOYNLABS_COMMS = process.env.KOYNLABS_COMMS || 0.2;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_1;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

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
    let transaction = new Transaction();

    if (!userData?.userKeypair?.secretKey) {
      throw new Error('Invalid user data or missing keypair');
    }

    const senderKeypair = Keypair.fromSecretKey(bs58.decode(Encryption.decrypt(userData.userKeypair.secretKey)));
    const commissionRate = parseFloat(KOYNLABS_COMMS);

    try {
      const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);
      console.log(`Initial balance: ${senderBalance / 1e9} SOL`);

      if (senderBalance <= 0) {
        throw new InsufficientBalanceError('Insufficient balance in sender wallet');
      }

      const amountToSend = Math.floor(senderBalance * commissionRate);
      console.log(`Commission amount: ${amountToSend / 1e9} SOL (${commissionRate * 100}%)`);

      // Get fresh blockhash
      const response = await fetch('http://localhost:3000/api/wallet/solana');
      const data = await response.json();

      if (!data.success) {
        throw new Error('Failed to get blockhash');
      }

      transaction.recentBlockhash = data.blockhash.blockhash;
      transaction.feePayer = senderKeypair.publicKey;

      // Add transfer instruction
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: senderKeypair.publicKey,
          toPubkey: new PublicKey(KOYNLABS_WALLET),
          lamports: amountToSend
        })
      );

      // Calculate fee
      const message = transaction.compileMessage();
      const { value: fee } = await this.connection.getFeeForMessage(message);

      const adjustedAmount = amountToSend - (fee / 1_000_000_000);

      if (adjustedAmount <= 0) {
        throw new Error('Amount too small to cover transaction fee');
      }

      // Create new transaction with adjusted amount
      transaction = new Transaction();
      transaction.recentBlockhash = data.blockhash.blockhash;
      transaction.feePayer = senderKeypair.publicKey;

      transaction.add(
        SystemProgram.transfer({
          fromPubkey: senderKeypair.publicKey,
          toPubkey: new PublicKey(KOYNLABS_WALLET),
          lamports: Math.round(adjustedAmount * 1_000_000_000)
        })
      );

      transaction.sign(senderKeypair);

      const serializedTransaction = transaction.serialize();
      const encodedTx = bs58.encode(serializedTransaction);

      // Submit transaction through API
      const submitResponse = await fetch('http://localhost:3000/api/transaction/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: this.chatId,
          publicKey: senderKeypair.publicKey.toString(),
          signedTransaction: encodedTx,
          type: 'send'
        })
      });

      const result = await submitResponse.json();
      if (!result.success) throw new Error(result.error || 'Transaction failed');

      console.log(`Commission transaction successful:
        Amount: ${amountToSend / 1e9} SOL
        From: ${senderKeypair.publicKey.toString()}
        To: ${KOYNLABS_WALLET}
        Signature: ${result.signature}
      `);

      return result.signature;
    } catch (error) {
      console.error(`Commission transaction failed:`, error);

      if (retries > 0) {
        console.log(`Retrying... (${retries} attempts left)`);
        await new Promise(resolve => setTimeout(resolve, 2000 * (4 - retries)));
        return this.sendToCommissionWallet(userData, retries - 1);
      }
      throw error;
    }
  }
}

module.exports = Commission;