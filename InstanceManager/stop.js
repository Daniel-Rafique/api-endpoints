const pm2 = require('pm2');

module.exports = {
    stopMarketMakerInstance(chatId) {
        return new Promise((resolve, reject) => {
            const instanceName = `marketMaker`;

            pm2.connect((err) => {
                if (err) {
                    console.error('Failed to connect to PM2:', err);
                    reject(err);
                    return;
                }

                pm2.stop(instanceName, (err) => {
                    if (err) {
                        console.error(`Failed to stop market maker instance ${instanceName}:`, err);
                        pm2.disconnect();
                        reject(err);
                        return;
                    }

                    console.log(`Market maker instance ${instanceName} stopped successfully`);
                    pm2.disconnect();
                    resolve();
                });
            });
        });
    }
};