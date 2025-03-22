require('dotenv').config();
const bs58 = require('bs58');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dataManager = require('../database')
const { Firestore } = require('@google-cloud/firestore');
const { Keypair } = require('@solana/web3.js');

const ENV_PATH = process.env.ENV_PATH;

class WalletManager {

    constructor(chatId) {
        this.chatId = chatId;
        this.dataManager = dataManager;
        this.firestore = new Firestore({
            projectId: 'koynlabs-2f749',
            keyFilename: '.config/firebaseServiceAccountKey.json',
        });
    }

    async createSolanaWallets(makers) {

        console.log("Creating wallets");
        const wallets = [];
        for (let i = 0; i < makers; i++) {
            const keypair = Keypair.generate();
            const secretKey = bs58.encode(Buffer.from(keypair.secretKey)); // Ensure Buffer.from is used
            const publicKey = keypair.publicKey.toString();
            wallets.push({ secretKey, publicKey });
        }
        return wallets;
    }

    async saveWallets(chatId, newWallets) {
        try {
            console.log("Saving wallets");

            // Step 1: Validation checks
            if (!chatId) {
                throw new Error('Invalid chatId');
            }

            if (!newWallets || newWallets.length === 0) {
                throw new Error('Invalid wallets data');
            }

            const chatIdStr = chatId.toString();

            // Step 2: Check wallet count limit
            // if (newWallets.length > 1000) {
            //     console.error(`Cannot add wallets: wallet count exceeds 100 for chatId: ${chatIdStr}`);
            //     throw new Error('Cannot add more than 100 wallets');
            // }

            // Step 3: Save wallets to file
            await this.saveWalletsToFile(chatIdStr, newWallets);

            console.log(`Successfully saved wallets to file for chatId: ${chatIdStr}`);
            return true;

        } catch (error) {
            console.error('Error saving wallets:', error.message || error);
            throw new Error('Failed to save wallets');
        }
    }

    async saveWalletsToFile(chatIdStr, newWallets) {
        try {
            // Check if newWallets is an array
            if (!Array.isArray(newWallets)) {
                throw new Error('newWallets must be an array');
            }

            // Resolve the path for the file
            const filePath = path.resolve(os.homedir(), ENV_PATH, `instances/user/${chatIdStr}/.config/wallets.json`);

            if (!filePath) {
                throw new Error('Error resolving filePath.');
            }

            // Ensure the directory exists using fs.promises.mkdir
            const dirPath = path.dirname(filePath);
            await fs.promises.mkdir(dirPath, { recursive: true });
            console.log(`Directory ensured: ${dirPath}`);

            // Prepare wallet data for saving
            const walletData = newWallets.map(wallet => ({
                publicKey: wallet.publicKey,
                secretKey: wallet.secretKey,
            }));

            // Write wallets data to file asynchronously
            await fs.promises.writeFile(filePath, JSON.stringify(walletData, null, 2));
            console.log(`Wallets saved to ${filePath}`);
        } catch (error) {
            console.error("Error saving wallets to file:", error);
            throw new Error('Failed to save wallets to file');
        }
    }
}

module.exports = WalletManager;