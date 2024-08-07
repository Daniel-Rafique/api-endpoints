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
        if (!userData.walletsCreated) {
          console.log('Creating wallets for chatId:', chatId);
          try {
            const walletsArray = this.walletManager.createSolanaWallets(makers);
            await this.walletManager.saveWallets(chatId, walletsArray);
          } catch (error) {
            console.log(error);
          }
        }
        if (userData.walletsCreated && !userData.instancesCreated) {
          console.log('Initializing market maker instance for chatId:', chatId);
          await this.instanceInitializer.initializeMarketMakerInstance(chatId);
        }

        if (userData.instancesCreated) {
          console.log('Airdrop Solana for chatId:', chatId);

          // Add debugging statements
          console.log('ENV_PATH:', ENV_PATH);
          console.log('chatId:', chatId);

          const filePath = path.resolve(os.homedir(), ENV_PATH, `instances/${chatId}/dist/wallets.json`);
          console.log('filePath:', filePath);

          await this.solana.distributeSolana(chatId);
        }
        console.log(`Processed job for chatId: ${chatId}`);
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