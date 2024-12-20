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

    async stopInstance(chatId) {
        return new Promise((resolve, reject) => {
            this.connectToPM2(() => {
                // First, list all PM2 processes to ensure the process exists
                pm2.list((err, processList) => {
                    if (err) {
                        console.error('Failed to list PM2 processes:', err);
                        pm2.disconnect();
                        reject(err);
                        return;
                    }

                    // Find the process that matches "MarketMaker"
                    const targetProcess = processList.find(proc => proc.name === "MarketMaker");

                    if (!targetProcess) {
                        console.error(`No MarketMaker instance found to stop for chat ${chatId}`);
                        pm2.disconnect();
                        reject(new Error('Process not found'));
                        return;
                    }

                    // Now stop the instance
                    pm2.stop("MarketMaker", (err) => {
                        if (err) {
                            console.error(`Failed to stop MarketMaker instance for chat ${chatId}:`, err);
                            pm2.disconnect();
                            reject(err);
                            return;
                        }

                        console.log(`MarketMaker instance for chat ${chatId} stopped successfully`);
                        this.savePM2Config();
                        pm2.disconnect();
                        resolve();
                    });
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

module.exports = InstanceStop;
