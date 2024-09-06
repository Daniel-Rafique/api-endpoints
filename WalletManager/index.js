require('dotenv').config();
const bs58 = require('bs58');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DataManager = require('../database')
const { Firestore } = require('@google-cloud/firestore');
const { Keypair } = require('@solana/web3.js');
const Solana = require('../Solana');

const ENV_PATH = process.env.ENV_PATH;
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
class WalletManager {

    constructor() {

        this.dataManager = new DataManager;
        this.solana = new Solana;

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
            const privateKey = bs58.encode(Buffer.from(keypair.secretKey)); // Ensure Buffer.from is used
            const publicKey = keypair.publicKey.toString();
            wallets.push({ privateKey, publicKey });
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
    
            const chatIdStr = chatId.toString(); // Ensure chatId is a string
            const docRef = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatIdStr);
    
            // Step 2: Retrieve the current document from Firestore to check its state
            const docSnapshot = await docRef.get();
            if (!docSnapshot.exists) {
                console.error(`Document for chatId ${chatIdStr} not found in Firestore.`);
                throw new Error('Document not found in Firestore');
            }
    
            // Step 3: Check the current number of wallets
            const existingWallets = docSnapshot.data().wallets || [];
            const totalWalletCount = existingWallets.length + newWallets.length;
    
            if (totalWalletCount > 100) {
                console.error(`Cannot add wallets: total wallet count exceeds 100 for chatId: ${chatIdStr}`);
                throw new Error('Cannot add more than 100 wallets');
            }
    
            // Step 4: Limit the number of new wallets if the total exceeds 100
            const walletsToAdd = newWallets.slice(0, 100 - existingWallets.length);
    
            // Step 5: Save wallets to file (assuming this is a necessary step)
            // Parallelizing file save operation
            const fileSavePromise = this.saveWalletsToFile(chatIdStr, walletsToAdd);
    
            // Step 6: Split wallets into batches to stay within Firestore's limits (if needed)
            const batchSize = 500; // Firestore's batch write limit
            const walletBatches = [];
            for (let i = 0; i < walletsToAdd.length; i += batchSize) {
                walletBatches.push(walletsToAdd.slice(i, i + batchSize));
            }
    
            // Step 7: Perform batch writes for each group of wallets
            for (const batchWallets of walletBatches) {
                const batch = this.firestore.batch();
                batch.update(docRef, {
                    wallets: Firestore.FieldValue.arrayUnion(...batchWallets),
                    walletsCreated: true // Set the flag to true after successfully adding wallets
                });
                await batch.commit();
            }
    
            // Step 8: Wait for file saving to complete
            await fileSavePromise;
    
            console.log(`Successfully saved and updated Firestore for chatId: ${chatIdStr}`);
    
        } catch (error) {
            console.error('Error saving to Firestore:', error.message || error);
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
            const filePath = path.resolve(os.homedir(), ENV_PATH, `instances/${chatIdStr}/dist/wallets.json`);
    
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
                secretKey: wallet.privateKey,
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