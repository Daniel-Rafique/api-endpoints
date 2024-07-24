const fs = require('fs');
const path = require('path');
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
    async initializeMarketMakerInstance(chatId, boostType) {
        // Create a unique directory for the user
        const userDir = `${this.instancePath}/${chatId}`;
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }

        // Recursively copy the base market maker files to the user directory
        this.copyRecursiveSync(this.basePath, userDir);

        // Append the CHAT_ID variable to the .env file without overwriting existing content
        const envFilePath = `${userDir}/.env`;
        const envContent = `CHAT_ID=${chatId}\n`;
        if (fs.existsSync(envFilePath)) {
            fs.appendFileSync(envFilePath, envContent);
        } else {
            fs.writeFileSync(envFilePath, envContent);
        }

        // Install dependencies and start the instance using PM2
        exec(`npm install`, { cwd: userDir }, (installError) => {
            if (installError) {
                console.error('Failed to install dependencies:', installError);
                return;
            }
            exec(`cd ${userDir} && pm2 start dist/index.js --name market-maker-${chatId}`, (pm2Error) => {
                if (pm2Error) {
                    console.error('Failed to start market maker instance with PM2:', pm2Error);
                }
            });
        });
    }

    // Function to recursively copy files and directories
    copyRecursiveSync(src, dest) {
        const exists = fs.existsSync(src);
        const stats = exists && fs.statSync(src);
        const isDirectory = exists && stats.isDirectory();
        if (isDirectory) {
            if (!fs.existsSync(dest)) {
                fs.mkdirSync(dest);
            }
            fs.readdirSync(src).forEach((childItemName) => {
                this.copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
            });
        } else {
            fs.copyFileSync(src, dest);
        }
    }
}

module.exports = InstanceInitializer;