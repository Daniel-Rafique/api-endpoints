const { Queue, Worker } = require('bullmq');
const WalletManager = require('../WalletManager');
const InstanceInitializer = require('../InstanceInitializer');
const DataManager = require('../Database/index.js');

class WalletProcessor {
  constructor() {
    this.walletManager = new WalletManager('koynlabs-2f749', '.config/firebaseServiceAccountKey.json');
    this.instanceInitializer = new InstanceInitializer('./marketMaker', './instances');
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
      const { chatId } = job.data;
      const userData = await this.dataManager.getCollection(chatId);
      const { contractAddress, batchSize, makers } = userData;

      try {
        const wallets = this.walletManager.createSolanaWallets(makers);
        await this.walletManager.saveWallets(chatId, wallets);
        await this.instanceInitializer.initializeMarketMakerInstance(chatId, contractAddress, batchSize);
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