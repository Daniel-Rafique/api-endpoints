// WalletWorker.js
const { Worker } = require('bullmq');
const WalletManager = require('../walletManager');
const MarketMakerManager = require('../marketMakerManager');
const InstanceInitializer = require('../instanceInitializer');

// Initialize WalletManager
const walletManager = new WalletManager('koynlabs-2f749', '.config/firebaseServiceAccountKey.json');

// Initialize MarketMakerManager
const marketMakerManager = new MarketMakerManager('./marketMaker', './instances');

// Initialize InstanceInitializer
const instanceInitializer = new InstanceInitializer('./marketMaker', './instances');

// Initialize WalletWorker
const walletWorker = new WalletWorker(walletManager, instanceInitializer);

class WalletWorker {
    constructor(walletManager, instanceInitializer, queueName = 'walletQueue', connectionOptions = { host: 'localhost', port: 6379 }) {
        this.walletManager = walletManager;
        this.instanceInitializer = instanceInitializer;

        this.worker = new Worker(queueName, async job => {
            const { chatId, boostType, count, contractAddress } = job.data;

            try {
                const wallets = this.walletManager.createSolanaWallets(count);
                await this.walletManager.saveWallets(chatId, boostType, wallets);
                await this.instanceInitializer.initializeMarketMakerInstance(chatId, boostType, count, contractAddress);
                console.log(`Processed job for chatId: ${chatId}`);
            } catch (error) {
                console.error('Error processing job:', error);
            }
        }, {
            connection: connectionOptions
        });
    }
}

module.exports = WalletWorker;
