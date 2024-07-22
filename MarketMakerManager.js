const { exec } = require('child_process');

class MarketMakerManager {
    constructor(sourceDir, instancesDir) {
        this.sourceDir = sourceDir;
        this.instancesDir = instancesDir;
    }

    copyMarketMakerDirectory(chatId, callback) {
        const targetDir = `${this.instancesDir}/${chatId}`;

        // Copy directory
        exec(`cp -r ${this.sourceDir} ${targetDir}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error copying directory: ${error}`);
                return callback(error);
            }

            // Pull latest code from main branch, install dependencies, and start with PM2
            this.setupMarketMaker(targetDir, chatId, callback);
        });
    }

    setupMarketMaker(targetDir, chatId, callback) {
        exec(`cd ${targetDir} && git pull origin main && npm install && pm2 start market-maker.js --name market-maker-${chatId}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error setting up market maker: ${error}`);
                return callback(error);
            }
            console.log(`Market maker bot setup complete and started for chatId: ${chatId}`);
            callback(null);
        });
    }
}

module.exports = MarketMakerManager;
