require('dotenv').config();
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const bs58 = require('bs58');
const Encryption = require('../utils/encryption');
const { MESSAGES } = require('../constants');
const Telegram = require('../Telegram');
const { Firestore } = require('@google-cloud/firestore');
const Discord = require('../Discord');

const redis = require('redis');
const client = redis.createClient();

client.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  await client.connect();
})();

const FIRESTORE_KEYSTORE = process.env.FIRESTORE_KEYSTORE;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_1;
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
    this.chatId = chatId;
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
      wsEndpoint: process.env.SOLANA_WEBSOCKET
    });
    this.telegramNotifier = new Telegram(TELEGRAM_TOKEN);
    this.discordNotifier = new Discord();
    this.messageCache = new Map();
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: path.join(os.homedir(), FIRESTORE_KEYSTORE, '.config/firebaseServiceAccountKey.json'),
    });
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

  async distributeSolana(chatId, userData) {
    if (!chatId || !userData) {
      throw new Error('Missing required parameters');
    }

    const { batchSize, makers, userKeypair } = userData;
    const retryLimit = 3;
    let attempt = 0;

    const updatedBalance = await this.connection.getBalance(userKeypair.publicKey);
    console.log(`Initial balance: ${updatedBalance / 1e9} SOL`);

    if (updatedBalance <= 0) {
      throw new InsufficientBalanceError('Insufficient balance in sender wallet');
    }

    while (attempt < retryLimit) {
      try {
        const senderKeypair = Keypair.fromSecretKey(bs58.decode(Encryption.decrypt(userKeypair.privateKey)));
        const filePath = path.resolve(os.homedir(), ENV_PATH, `instances/${chatId}/dist/wallets.json`);

        await this.waitForFile(filePath, 30000);

        const fileContent = await fs.readFile(filePath, 'utf8');
        const newWallets = JSON.parse(fileContent);

        if (newWallets.length > 1000) {
          throw new Error('Maximum wallet limit exceeded (1000)');
        }

        const amountPerWallet = userData.amountPerWallet;
        console.log(`Amount per wallet: ${amountPerWallet / 1e9} SOL`);

        const totalBatches = Math.ceil(newWallets.length / batchSize);
        for (let i = 0; i < newWallets.length; i += batchSize) {
          const currentBatch = Math.floor(i / batchSize) + 1;
          console.log(`Processing batch ${currentBatch}/${totalBatches}`);

          const chunk = newWallets.slice(i, i + batchSize);
          const dropList = chunk.map(wallet => ({
            walletAddress: wallet.publicKey.toString(),
            numLamports: amountPerWallet,
          }));

          const results = await this.generateTransactions(dropList, senderKeypair, userData);
          await this.logTransactionResults(results, currentBatch);
        }

        // console.log('Distribution completed successfully');
        await this.sendNotification(
          userData,
          `✅ Labs ${userData.boostName} tier will begin shortly for ${userData.tokenDetails.symbol}\n`
        );

        return true;

      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed:`, error);
        if (attempt === retryLimit - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      }
      attempt++;
    }
  }

  async waitForFile(filePath, timeout) {
    const startTime = Date.now();
    while (true) {
      if (Date.now() - startTime > timeout) {
        throw new Error(`Timeout waiting for file: ${filePath}`);
      }
      try {
        await fs.access(filePath);
        return;
      } catch (err) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async generateTransactions(dropList, fromWallet, userData, retries = 3) {
    if (!dropList?.length || !fromWallet || !userData?.makers) {
      throw new Error('Invalid parameters for transaction generation');
    }

    const results = [];

    for (const drop of dropList) {
      try {
        let transaction = new Transaction();

        // Get fresh blockhash from API
        const response = await fetch('http://localhost:3000/api/wallet/solana');
        const data = await response.json();
        if (!data.success) {
          throw new Error('Failed to get blockhash');
        }

        transaction.recentBlockhash = data.blockhash.blockhash;
        transaction.feePayer = fromWallet.publicKey;

        // Add initial transfer instruction
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: fromWallet,
            toPubkey: new PublicKey(drop.walletAddress),
            lamports: drop.numLamports
          })
        );

        // Calculate fee
        const message = transaction.compileMessage();
        const { value: fee } = await this.connection.getFeeForMessage(message);

        // Create new transaction with adjusted amount
        transaction = new Transaction();
        transaction.recentBlockhash = data.blockhash.blockhash;
        transaction.feePayer = fromWallet.publicKey;

        const adjustedAmount = drop.numLamports - (fee ?? 0);
        if (adjustedAmount <= 0) {
          throw new Error('Amount too small to cover transaction fee');
        }

        transaction.add(
          SystemProgram.transfer({
            fromPubkey: fromWallet,
            toPubkey: new PublicKey(drop.walletAddress),
            lamports: adjustedAmount
          })
        );

        transaction.sign(fromWallet);
        const serializedTransaction = transaction.serialize();
        const encodedTx = bs58.encode(serializedTransaction);

        // Submit transaction through API
        const submitResponse = await fetch('http://localhost:3000/api/transaction/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId: this.chatId,
            publicKey: fromWallet.publicKey.toString(),
            signedTransaction: encodedTx,
            type: 'send'
          })
        });

        const result = await submitResponse.json();
        if (!result.success) throw new Error(result.error || 'Transaction failed');

        results.push({
          success: true,
          signature: result.signature,
          recipient: drop.walletAddress,
          amount: adjustedAmount
        });

      } catch (error) {
        if (retries > 0) {
          console.log(`Retrying transaction for ${drop.walletAddress}... (${retries} attempts left)`);
          await new Promise(resolve => setTimeout(resolve, 2000 * (4 - retries)));
          return this.generateTransactions(dropList, fromWallet, userData, retries - 1);
        }
        throw error;
      }
    }

    return results;
  }

  async logTransactionResults(results, batchNumber) {
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    const message = `Batch ${batchNumber} results: ` +
      `✅ ${successful} successful, ❌ ${failed} failed`;

    console.log(message);
  }
}

module.exports = Distribute;