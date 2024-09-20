const pm2 = require('pm2');
const { exec } = require('child_process');

class InstanceStop {
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

    stopInstance(chatId) {
        return new Promise((resolve, reject) => {
            this.connectToPM2(() => {
                // Use chatId or specific process name/ID to stop the correct instance
                pm2.stop("MarketMaker", (err) => {
                    if (err) {
                        console.error(`Failed to stop MarketMaker instance:`, err);
                        pm2.disconnect();
                        reject(err); // Reject the promise if stop fails
                        return;
                    }

                    console.log(`MarketMaker instance stopped successfully`);
                    pm2.disconnect(); // Always disconnect from PM2 after operations
                    resolve(); // Resolve the promise
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

            exec('pm2 startup', (err, stdout, stderr) => {
                if (err) {
                    console.error('Failed to generate PM2 startup script:', stderr);
                } else {
                    console.log('PM2 startup script generated successfully');
                }
            });
        });
    }

    async stopAndSaveInstance(chatId) {
        try {
            // First, stop the instance
            await this.stopInstance(chatId);

            // Once the instance is stopped, save PM2 config
            this.savePM2Config();
        } catch (error) {
            console.error('Error while stopping the instance and saving PM2 config:', error);
        }
    }
}

module.exports = InstanceStop;
