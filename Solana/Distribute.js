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
    this.distributionLocks = new Map();
  }

  async sendNotification(userData, message, interaction) {
    try {
      // First check if the message is empty or invalid
      if (!message || typeof message !== 'string') {
        console.log('Skipping empty or invalid notification message');
        return;
      }
      
      // Check if we're sending to Discord
      if (userData && userData.platform === 'discord') {
        // Only attempt to send if interaction exists
        if (interaction) {
          await this.discordNotifier.sendDiscordMessage(interaction, {
            content: message,
            flags: 64
          });
          console.log('Discord notification sent successfully');
        } else {
          console.log('Skipping Discord message - no interaction provided');
        }
      } 
      // Otherwise send to Telegram
      else {
        // Ensure chatId is valid
        const chatId = this.chatId || (userData && userData.chatId);
        if (!chatId) {
          console.log('Skipping Telegram message - no valid chatId');
          return;
        }
        
        // Try to send the Telegram message
        const result = await this.telegramNotifier.sendTelegramMessage(chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: true
        });
        
        if (result && result.ok) {
          console.log('Telegram notification sent successfully');
        } else {
          console.warn('Telegram message may not have been delivered:', result);
        }
      }
    } catch (error) {
      // Don't let notification failures affect the main process
      console.error(`Failed to send notification (non-critical error): ${error.message}`);
    }
  }

  async distributeSolana(chatId, userData, interaction) {
    if (!chatId || !userData) {
      throw new Error('Missing required parameters');
    }

    // Check if distribution is already in progress for this chatId
    if (this.distributionLocks.get(chatId)) {
      console.log(`Distribution already in progress for chat ${chatId}`);
      return;
    }

    // Set the lock for this chatId
    this.distributionLocks.set(chatId, true);

    try {
      const { batchSize, userKeypair } = userData;
      const retryLimit = 3;
      let attempt = 0;

      // Convert publicKey to a proper PublicKey object if it's a string
      const publicKeyObj = typeof userKeypair.publicKey === 'string' 
        ? new PublicKey(userKeypair.publicKey) 
        : userKeypair.publicKey;

      console.log(`Checking balance for public key: ${publicKeyObj.toString()}`);
      const updatedBalance = await this.connection.getBalance(publicKeyObj);
      console.log(`Initial balance: ${updatedBalance / 1e9} SOL`);

      if (updatedBalance <= 0) {
        throw new InsufficientBalanceError('Insufficient balance in sender wallet');
      }

      while (attempt < retryLimit) {
        try {
          const senderKeypair = Keypair.fromSecretKey(bs58.decode(Encryption.decrypt(userKeypair.secretKey)));
          const filePath = path.resolve(os.homedir(), ENV_PATH, `instances/user/${chatId}/.config/wallets.json`);

          await this.waitForFile(filePath, 30000);

          const fileContent = await fs.readFile(filePath, 'utf8');
          const newWallets = JSON.parse(fileContent);

          if (newWallets.length > 1000) {
            throw new Error('Maximum wallet limit exceeded (1000)');
          }

          // Ensure we're working with lamports (integers)
          let amountPerWallet;
          if (typeof userData.amountPerWallet === 'number') {
            // If in SOL, convert to lamports
            if (userData.amountPerWallet < 1) {
              // This is likely in SOL, convert to lamports
              amountPerWallet = Math.floor(userData.amountPerWallet * 1e9);
            } else {
              // Already in lamports
              amountPerWallet = Math.floor(userData.amountPerWallet);
            }
          } else {
            // Default to minimum amount if missing
            amountPerWallet = 5000; // 0.000005 SOL minimum
          }

          // Ensure amount is at least enough for rent exemption
          const minRentExemption = await this.connection.getMinimumBalanceForRentExemption(0);
          if (amountPerWallet < minRentExemption) {
            console.warn(`Amount per wallet (${amountPerWallet}) is less than minimum rent exemption (${minRentExemption}). Using minimum rent exemption + 5000 lamports`);
            amountPerWallet = minRentExemption + 5000;
          }

          console.log(`Amount per wallet: ${amountPerWallet} lamports (${amountPerWallet / 1e9} SOL)`);

          const totalBatches = Math.ceil(newWallets.length / batchSize);
          for (let i = 0; i < newWallets.length; i += batchSize) {
            const currentBatch = Math.floor(i / batchSize) + 1;
            console.log(`Processing batch ${currentBatch}/${totalBatches}`);

            const chunk = newWallets.slice(i, i + batchSize);
            const dropList = chunk.map(wallet => ({
              walletAddress: wallet.publicKey,
              numLamports: amountPerWallet,
            }));

            const results = await this.generateTransactions(dropList, senderKeypair, userData);
            await this.logTransactionResults(results, currentBatch);
          }

          try {
            const tokenName = userData.tokenDetails?.name || 'your token';
            const boostName = userData.boostName || 'Basic';
            await this.sendNotification(
              userData,
              `✅ SOL distribution successful. ${boostName} tier for ${tokenName} will begin shortly.`,
              interaction
            );
          } catch (notifyError) {
            console.log('Failed to send final notification, but distribution was successful:', notifyError.message);
          }

          return true;

        } catch (error) {
          console.error(`Attempt ${attempt + 1} failed:`, error);
          if (attempt === retryLimit - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        }
        attempt++;
      }
    } finally {
      // Always release the lock
      this.distributionLocks.delete(chatId);
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
    if (!dropList?.length || !fromWallet) {
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

        // Convert to integer lamports - ensure it's a whole number
        const lamports = Math.floor(drop.numLamports);
        if (lamports <= 0) {
          console.warn(`Skipping transfer to ${drop.walletAddress} due to amount too small: ${drop.numLamports}`);
          continue; // Skip this transfer if amount is too small
        }

        // Add initial transfer instruction with integer lamports
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: fromWallet.publicKey,
            toPubkey: new PublicKey(drop.walletAddress),
            lamports: lamports
          })
        );

        // Calculate fee
        const message = transaction.compileMessage();
        const { value: fee } = await this.connection.getFeeForMessage(message);
        const minRentExemption = await this.connection.getMinimumBalanceForRentExemption(0);
        const totalFee = fee + minRentExemption;
        
        // Create new transaction with adjusted amount
        transaction = new Transaction();
        transaction.recentBlockhash = data.blockhash.blockhash;
        transaction.feePayer = fromWallet.publicKey;

        // Ensure adjusted amount is an integer
        const adjustedAmount = Math.floor(lamports - totalFee);
        if (adjustedAmount <= 0) {
          console.warn(`Skipping transfer to ${drop.walletAddress} due to amount too small after fees: ${lamports} lamports, fee: ${totalFee} lamports`);
          continue; // Skip this transfer if amount is too small after fees
        }

        console.log(`Sending ${adjustedAmount} lamports (${adjustedAmount / 1e9} SOL) to ${drop.walletAddress}`);
        
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: fromWallet.publicKey,
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
        console.error(`Transaction error:`, error);
        results.push({
          success: false,
          error: error.message,
          recipient: drop.walletAddress
        });
      }
    }

    return results;
  }

  async logTransactionResults(results, batchNumber) {
    // Count successes and failures
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    const message = `Batch ${batchNumber} results: ` +
      `✅ ${successful} successful, ❌ ${failed} failed`;

    console.log(message);
  }

  // Add helper method to check lock status
  isDistributionInProgress(chatId) {
    return this.distributionLocks.get(chatId) === true;
  }
}

module.exports = Distribute;