const fs = require('fs');
const { exec } = require('child_process');
const admin = require('firebase-admin');

class instanceInitializer {
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
    async initializeMarketMakerInstance(chatId, boostType) {

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
            CHAT_ID=${chatId}
        `;
        fs.writeFileSync(`${userDir}/.env`, envContent);

        // Install dependencies and start the instance using PM2
        exec(`npm install`, { cwd: userDir }, (installError) => {
            if (installError) {
                console.error('Failed to install dependencies:', installError);
                return;
            }
            exec(`pm2 start ${userDir}/dist/index.js --name market-maker-${chatId}`, (pm2Error) => {
                if (pm2Error) {
                    console.error('Failed to start market maker instance with PM2:', pm2Error);
                }
            });
        });
    }
}

module.exports = instanceInitializer;
