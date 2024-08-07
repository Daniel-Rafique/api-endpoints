require('dotenv').config();
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');
const DataManager = require('../database')
const { Firestore } = require('@google-cloud/firestore');
const { Keypair } = require('@solana/web3.js');
const Solana = require('../Solana');

const ENV_PATH = process.env.ENV;
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
            const chatIdStr = chatId.toString(); // Ensure chatId is a string
            const docRef = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatIdStr);

            // Add new wallets to the existing array
            await docRef.update({
                wallets: Firestore.FieldValue.arrayUnion(...newWallets),
                walletsCreated: true
            });

            console.log(`Saved ${newWallets.length} wallets for chatId: ${chatIdStr}`);
            await this.saveWalletsToFile(chatIdStr, newWallets)
        } catch (error) {
            console.error('Error saving to Firestore:', error);
            throw new Error('Failed to save wallets');
        }
    }

    async saveWalletsToFile(chatIdStr, newWallets) {
        try {
            const filePath = path.resolve(__dirname, `~/${ENV_PATH}/instances/${chatId}/wallets.json`);
            const walletData = newWallets.map(wallet => ({
                publicKey: wallet.publicKey,
                secretKey: wallet.privateKey
            }));

            fs.writeFileSync(filePath, JSON.stringify(walletData, null, 2));
            await this.solana.distributeSolana(chatIdStr);
            console.log(`Wallets saved to ${filePath}`);
        } catch (error) {
            console.error("Error saving wallets to file:", error);
        }
    }

}

module.exports = WalletManager;