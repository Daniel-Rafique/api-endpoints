require('dotenv').config();
const path = require('path');
const os = require('os');
const { Queue, Worker } = require('bullmq');
const DataManager = require('../database');
const WalletManager = require('../WalletManager');
const InstanceInitializer = require('../InstanceInitializer');
const Solana = require('../Solana');

const ENV_PATH = process.env.ENV_PATH;

if (!ENV_PATH) {
  throw new Error('ENV_PATH is not defined. Please check your .env file.');
}

class WalletProcessor {
  constructor() {
    this.walletManager = new WalletManager();

    // Define absolute paths
    const basePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker');
    const instancePath = path.resolve(os.homedir(), ENV_PATH, 'instances');

    if (!basePath || !instancePath) {
      throw new Error('Error resolving basePath or instancePath.');
    }

    this.instanceInitializer = new InstanceInitializer(basePath, instancePath);
    this.dataManager = new DataManager();
    this.solana = new Solana();

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
      const { chatId } = job.data;
      console.log('Processing job for chatId:', chatId); // Log chatId
      const userData = await this.dataManager.getCollection(chatId);
      const { makers } = userData;

      try {
        const walletsArray = this.walletManager.createSolanaWallets(makers);
        await this.walletManager.saveWallets(chatId, walletsArray);
        console.log(`Processed wallets for chatId: ${chatId}`);

      } catch (error) {
        console.error('Error processing job:', error);
      }
    }, {
      connection: {
        host: 'localhost',
        port: 6379
      }
    });
  }

  addJob(data) {
    return this.walletQueue.add('createWallets', data);
  }
}

module.exports = WalletProcessor;