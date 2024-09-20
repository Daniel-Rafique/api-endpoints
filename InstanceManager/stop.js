const pm2 = require('pm2');

class InstanceStop {
    constructor() {
        this.pm2 = pm2;
    }

    stopInstance(chatId) {
        return new Promise((resolve, reject) => {
            const instanceName = "MarketMaker";
            console.log("Stopping rign now", instanceName)

            this.pm2.connect((err) => {
                if (err) {
                    console.error('Failed to connect to PM2:', err);
                    reject(err);
                    return;
                }

                this.pm2.stop(instanceName, (err) => {
                    if (err) {
                        console.error(`Failed to stop market maker instance ${instanceName}:`, err);
                        this.pm2.disconnect();
                        reject(err);
                        return;
                    }

                    console.log(`Market maker instance ${instanceName} stopped successfully`);
                    this.pm2.disconnect();
                    resolve();
                });
            });
        });
    }
}

module.exports = InstanceStop;