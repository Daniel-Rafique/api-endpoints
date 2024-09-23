const pm2 = require('pm2');
const { exec } = require('child_process');

class InstanceStart {
    constructor() {
        this.pm2 = pm2;
    }

    connectToPM2(callback) {
        pm2.connect((err) => {
            if (err) {
                console.error('Failed to connect to PM2:', err);
                setTimeout(() => this.connectToPM2(callback), 1000);
                return;
            }
            callback();
        });
    }

    startInstance(chatId) {
        return new Promise((resolve, reject) => {
            this.connectToPM2(() => {
                console.log('Starting instance', chatId)
                pm2.start({
                    script: '~/devnet-api/MarketMaker/dist/index.js',
                    name: `MarketMaker`,
                    args: [chatId]
                }, (err) => {
                    if (err) {
                        console.error(`Failed to start market maker instance for chat ${chatId}:`, err);
                        pm2.disconnect();
                        reject(err);  // Reject the promise on failure
                        return;
                    }

                    console.log(`Market maker instance for chat ${chatId} started successfully`);
                    this.savePM2Config();
                    pm2.disconnect();  // Disconnect after starting the instance
                    resolve();  // Resolve the promise on success
                });
            });
        });
    }

    savePM2Config() {
        exec('pm2 save', (err, stdout, stderr) => {
            if (err) {
                console.error('Failed to save PM2 process list:', stderr);
            } else {
                console.log('PM2 process list saved successfully');
            }
        });
    }
}

module.exports = InstanceStart;
