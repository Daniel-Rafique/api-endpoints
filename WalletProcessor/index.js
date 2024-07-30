const { Queue, Worker } = require('bullmq');
const WalletManager = require('../WalletManager');
const InstanceInitializer = require('../InstanceInitializer');

class WalletProcessor {
  constructor() {
    this.walletManager = new WalletManager('koynlabs-2f749', '.config/firebaseServiceAccountKey.json');
    this.instanceInitializer = new InstanceInitializer('./marketMaker', './batchSize');
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
      const { chatId, contractAddress, boostType, boostCost, wallet, batchSize, makers, timestamp } = job.data;

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