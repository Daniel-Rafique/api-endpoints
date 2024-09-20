const pm2 = require('pm2');
const { exec } = require('child_process');

class InstanceManager {
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
        this.connectToPM2(() => {
            pm2.start({
                name: `MarketMaker`,
                env: {
                    NODE_ENV: 'production',
                    CHAT_ID: chatId,
                }
            }, (err) => {
                if (err) {
                    console.error(`Failed to start market maker instance for chat ${chatId}:`, err);
                    pm2.disconnect();
                    return;
                }

                console.log(`Market maker instance for chat ${chatId} started successfully`);
                this.savePM2Config();
            });
        });
    }

    stopInstance(chatId) {
        this.connectToPM2(() => {
            pm2.stop(`MarketMaker-${chatId}`, (err) => {
                if (err) {
                    console.error(`Failed to stop market maker instance for chat ${chatId}:`, err);
                    pm2.disconnect();
                    return;
                }

                console.log(`Market maker instance for chat ${chatId} stopped successfully`);
                this.savePM2Config();
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
                pm2.disconnect();
            });
        });
    }
}

module.exports = InstanceManager;