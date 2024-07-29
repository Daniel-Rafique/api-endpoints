const { Worker } = require('bullmq');
const WalletManager = require('../walletManager');
const InstanceInitializer = require('../instanceInitializer');

class WalletWorker {
    constructor(queueName = 'walletQueue', connectionOptions = { host: 'localhost', port: 6379 }) {
        this.walletManager = new WalletManager('koynlabs-2f749', '.config/firebaseServiceAccountKey.json');
        this.instanceInitializer = new InstanceInitializer('./marketMaker', './instances');

        this.worker = new Worker(queueName, async job => {
            const { chatId, boostType, makers, contractAddress } = job.data;

            try {
                const wallets = this.walletManager.createSolanaWallets(count);
                await this.walletManager.saveWallets(chatId, boostType, wallets);
                await this.instanceInitializer.initializeMarketMakerInstance(chatId, boostType, makers, contractAddress);
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
