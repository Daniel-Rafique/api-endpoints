require('dotenv').config();
const path = require('path');
const os = require('os');
const { Queue, Worker } = require('bullmq');
const DataManager = require('../database');
const WalletManager = require('../WalletManager');

const ENV_PATH = process.env.ENV_PATH;

if (!ENV_PATH) {
  throw new Error('ENV_PATH is not defined. Please check your .env file.');
}

class WalletProcessor {
  constructor(chatId) {
    this.chatId = chatId;
    this.walletManager = new WalletManager(chatId);
    // Define absolute paths
    const basePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker');
    const instancePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker', 'instances');

    if (!basePath || !instancePath) {
      throw new Error('Error resolving basePath or instancePath.');
    }

    this.dataManager = new DataManager();

    this.walletQueue = new Queue('walletQueue', {
      connection: {
        host: 'localhost',
        port: 6379
      }
    });

    this.initializeWorker();
  }

  initializeWorker() {
    new Worker('walletQueue', async job => {
      const { chatId, userData } = job.data;
      const { makers, boostType, userKeypair } = userData;
      console.log('Processing job for chatId:', chatId); // Log chatId

      try {
        let walletsArray;
        if (boostType === 'solo') {
          walletsArray = [userKeypair]; // Use the provided userKeypair for solo mode
        } else {
          walletsArray = await this.walletManager.createSolanaWallets(makers);
        }
        await this.walletManager.saveWallets(chatId, walletsArray);
        console.log(`Processed wallets for chatId: ${chatId}`);

      } catch (error) {
        console.error('Error processing job:', error);
        throw new Error('Failed to process job');

      }
    }, {
      connection: {
        host: 'localhost',
        port: 6379
      }
    });
  }

  addJob(data) {
    console.log('Adding create wallet job to queue:', data);
    return this.walletQueue.add('createWallets', data);
  }
}

module.exports = WalletProcessor;