const pm2 = require('pm2');

class InstanceStart {
    constructor(chatId) {
        this.pm2 = pm2;
        this.chatId = chatId;
    }

    startInstance() {
        return new Promise((resolve, reject) => {
            const instanceName = `marketMaker-${this.chatId}`;

            this.pm2.connect((err) => {
                if (err) {
                    console.error('Failed to connect to PM2:', err);
                    reject(err);
                    return;
                }

                this.pm2.start(instanceName, (err) => {
                    if (err) {
                        console.error(`Failed to start market maker instance ${instanceName}:`, err);
                        this.pm2.disconnect();
                        reject(err);
                        return;
                    }

                    console.log(`Market maker instance ${instanceName} started successfully`);
                    this.pm2.disconnect();
                    resolve();
                });
            });
        });
    }
}

module.exports = InstanceStart;