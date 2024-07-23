const fs = require('fs');
const { exec } = require('child_process');
const admin = require('firebase-admin');

class InstanceInitializer {
    constructor(basePath, instancePath) {
        this.basePath = basePath;
        this.instancePath = instancePath;
    }

    // Function to get the private key from Firestore
    async getPrivateKey(chatId) {
        const doc = await admin.firestore().collection('mm').doc(chatId.toString()).get();
        if (!doc.exists) {
            throw new Error('No such document!');
        }
        const data = doc.data();
        return data.privateKey; // Ensure your Firestore document has the 'privateKey' field
    }

    // Function to initialize a market maker instance
    async initializeMarketMakerInstance(chatId, boostType, count) {
        const privateKey = await this.getPrivateKey(chatId);

        // Create a unique directory for the user
        const userDir = `${this.instancePath}/${chatId}`;
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }

        // Copy the base market maker files to the user directory
        fs.copyFileSync(`${this.basePath}/`, `${userDir}/`);
        fs.copyFileSync(`${this.basePath}/package.json`, `${userDir}/package.json`);

        // Create a .env file with user-specific environment variables
        const envContent = `
            SOLANA_RPC_ENDPOINT=${process.env.SOLANA_RPC_ENDPOINT}
            ENABLE_TRADING=true
            PRIVATE_KEY=${privateKey}
            CHAT_ID=${chatId}
            BOOST_TYPE=${boostType}
            WALLET_COUNT=${count}
        `;
        fs.writeFileSync(`${userDir}/.env`, envContent);

        // Install dependencies and start the instance using PM2
        exec(`npm install`, { cwd: userDir }, (installError) => {
            if (installError) {
                console.error('Failed to install dependencies:', installError);
                return;
            }
            exec(`pm2 start ${userDir}/index.js --name market-maker-${chatId}`, (pm2Error) => {
                if (pm2Error) {
                    console.error('Failed to start market maker instance with PM2:', pm2Error);
                }
            });
        });
    }
}

module.exports = instanceInitializer;
