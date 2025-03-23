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
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const discordToken = process.env.DISCORD_BOT_TOKEN;

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
    this.telegramNotifier = new Telegram(telegramToken);
    this.discordNotifier = new Discord(discordToken);
    this.messageCache = new Map();
    this.isProcessingCommission = false;

    if (!KOYNLABS_WALLET || !KOYNLABS_COMMS) {
      throw new Error('Missing required environment variables');
    }
  }

  async sendNotification(userData, message) {
    try {
      if (userData.platform === 'discord') {
        await this.discordNotifier.sendDiscordMessage(this.chatId, message);
      } else {
        await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
      }
    } catch (error) {
      console.error(`Failed to send notification: ${error.message}`);
    }
  }

  async sendToCommissionWallet(chatId, userData, interaction, retries = 3) {
    if (this.isProcessingCommission) {
      console.log('Commission transaction already in progress');
      return null;
    }

    this.isProcessingCommission = true;

    try {
      // Validate input data
      if (!userData?.userKeypair?.secretKey) {
        throw new Error('Invalid user data or missing keypair');
      }

      // Validate commission rate
      const commissionRate = parseFloat(KOYNLABS_COMMS);
      if (isNaN(commissionRate) || commissionRate <= 0 || commissionRate >= 1) {
        throw new Error(`Invalid commission rate: ${KOYNLABS_COMMS}`);
      }

      // Validate commission wallet
      if (!KOYNLABS_WALLET) {
        throw new Error('Missing KOYNLABS_WALLET environment variable');
      }

      try {
        // Create keypair from secretKey
        const senderKeypair = Keypair.fromSecretKey(bs58.decode(Encryption.decrypt(userData.userKeypair.secretKey)));
        
        // Get sender balance
        console.log(`Checking balance for: ${senderKeypair.publicKey.toString()}`);
        const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);
        console.log(`Initial balance: ${senderBalance / 1e9} SOL`);

        if (senderBalance <= 0) {
          throw new InsufficientBalanceError('Insufficient balance in sender wallet');
        }

        // Calculate commission amount in lamports (not SOL)
        const amountInLamports = Math.floor(senderBalance * commissionRate);
        console.log(`Commission amount: ${amountInLamports / 1e9} SOL (${commissionRate * 100}%)`);

        // Get fresh blockhash
        const response = await fetch('http://localhost:3000/api/wallet/solana');
        const data = await response.json();

        if (!data.success) {
          throw new Error(`Failed to get blockhash: ${data.error || 'Unknown error'}`);
        }

        // Create and populate transaction
        let transaction = new Transaction();
        transaction.recentBlockhash = data.blockhash.blockhash;
        transaction.feePayer = senderKeypair.publicKey;

        // Calculate fee
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: senderKeypair.publicKey,
            toPubkey: new PublicKey(KOYNLABS_WALLET),
            lamports: amountInLamports
          })
        );
        const message = transaction.compileMessage();
        const { value: fee } = await this.connection.getFeeForMessage(message);
        
        // Adjust amount for fee
        const adjustedAmount = amountInLamports - fee;

        if (adjustedAmount <= 0) {
          throw new Error(`Amount too small to cover transaction fee: ${amountInLamports} lamports, fee: ${fee} lamports`);
        }

        // Create new transaction with adjusted amount
        transaction = new Transaction();
        transaction.recentBlockhash = data.blockhash.blockhash;
        transaction.feePayer = senderKeypair.publicKey;

        transaction.add(
          SystemProgram.transfer({
            fromPubkey: senderKeypair.publicKey,
            toPubkey: new PublicKey(KOYNLABS_WALLET),
            lamports: adjustedAmount
          })
        );

        // Sign and serialize
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
        if (!result.success) {
          throw new Error(result.error || 'Transaction failed');
        }

        console.log(`Commission transaction successful:
          Amount: ${adjustedAmount / 1e9} SOL
          From: ${senderKeypair.publicKey.toString()}
          To: ${KOYNLABS_WALLET}
          Signature: ${result.signature}
        `);

        // Send notification about successful commission payment
        try {
          await this.sendNotification(userData, `✅ Commission payment of ${(adjustedAmount / 1e9).toFixed(6)} SOL sent successfully.`);
        } catch (notifyError) {
          console.error('Failed to send notification (non-critical):', notifyError);
        }

        return result.signature;
      } catch (error) {
        console.error(`Commission transaction failed:`, error);

        if (error instanceof InsufficientBalanceError) {
          await this.sendNotification(userData, '❌ Commission payment failed: Insufficient balance in wallet.');
          throw error;
        }

        if (retries > 0) {
          console.log(`Retrying... (${retries} attempts left)`);
          this.isProcessingCommission = false;
          await new Promise(resolve => setTimeout(resolve, 2000 * (4 - retries)));
          return this.sendToCommissionWallet(chatId, userData, interaction, retries - 1);
        }
        
        // Send failure notification on last retry
        try {
          await this.sendNotification(userData, `❌ Commission payment failed: ${error.message}`);
        } catch (notifyError) {
          console.error('Failed to send error notification:', notifyError);
        }
        
        throw error;
      }
    } finally {
      this.isProcessingCommission = false;
    }
  }
}

module.exports = Commission;