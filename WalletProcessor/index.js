const { Queue, Worker } = require('bullmq');
const DataManager = require('../database');
const WalletManager = require('../WalletManager');
const InstanceInitializer = require('../InstanceInitializer');
const Solana = require('../Solana');

class WalletProcessor {
  constructor() {
    this.walletManager = new WalletManager();

    // Prepare the directories for initialization
    this.instanceInitializer = new InstanceInitializer('./marketMaker', './instances');
    this.dataManager = new DataManager();
    this.solana = new Solana;

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
      const { makers } = userData;
      try {
        const userData = this.dataManager.getCollection(chatId);
        if (userData.walletsCreated === false) {
          console.log('Creating wallets')
          try {
            const walletsArray = this.walletManager.createSolanaWallets(makers, chatId);
            await this.walletManager.saveWallets(chatId, walletsArray);
          } catch (error) {
            console.log(error)
          }
        }
        if (userData.airDropSolana === false) {
          await this.solana.airDropSolana(chatId)
        }

        if(userData.instancesCreated === false){
          await this.instanceInitializer.initializeMarketMakerInstance(chatId);
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