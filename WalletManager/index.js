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

    createSolanaWallets(makers) {

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
            if (!chatId) {
                throw new Error('Invalid chatId');
            }
    
            if (!newWallets || newWallets.length === 0) {
                throw new Error('Invalid wallets data');
            }
    
            const chatIdStr = chatId.toString(); // Ensure chatId is a string
            const docRef = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatIdStr);
            
            // Step 1: Save wallets to file (assuming this is a necessary step)
            await this.saveWalletsToFile(chatIdStr, newWallets);
    
            console.log(`Saved ${newWallets.length} wallets for chatId: ${chatIdStr}`);
    
            // Step 2: Retrieve the current document from Firestore to check its state
            const docSnapshot = await docRef.get();
            if (!docSnapshot.exists) {
                console.error(`Document for chatId ${chatIdStr} not found in Firestore.`);
                throw new Error('Document not found in Firestore');
            }
    
            // Step 3: Add new wallets to the existing array and update the `walletsCreated` flag
            await docRef.update({
                wallets: Firestore.FieldValue.arrayUnion(...newWallets),
                walletsCreated: true // Set the flag to true after successfully adding wallets
            });
    
            console.log(`Successfully updated Firestore for chatId: ${chatIdStr}`);
            return true;
    
        } catch (error) {
            console.error('Error saving to Firestore:', error.message || error);
            throw new Error('Failed to save wallets');
        }
    }
    

    async saveWalletsToFile(chatIdStr, newWallets) {
        try {
            // Resolve the path for the file
            const filePath = path.resolve(os.homedir(), ENV_PATH, `instances/${chatIdStr}/dist/wallets.json`);

            if (!filePath) {
                throw new Error('Error resolving filePath.');
            }

            // Ensure the directory exists
            const dirPath = path.dirname(filePath);
            if (!fs.existsSync(dirPath)) {
                fs.mkdirSync(dirPath, { recursive: true });
                console.log(`Directory created: ${dirPath}`);
            }

            // Create or overwrite the wallets file
            fs.writeFileSync(filePath, '[]', { flag: 'w' }); // Initialize the file with an empty array

            // Prepare wallet data
            const walletData = newWallets.map(wallet => ({
                publicKey: wallet.publicKey,
                secretKey: wallet.privateKey,
            }));

            // Write wallets to file
            fs.writeFileSync(filePath, JSON.stringify(walletData, null, 2));
            console.log(`Wallets saved to ${filePath}`);
        } catch (error) {
            console.error("Error saving wallets to file:", error);
            throw new Error('Failed to save wallets to file ');
        }
    }

}

module.exports = WalletManager;