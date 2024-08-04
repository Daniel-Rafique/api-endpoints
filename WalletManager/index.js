require('dotenv').config();
const bs58 = require('bs58');
const fs = require('fs');
const path = require('path');
const DataManager = require('../database')
const { Firestore } = require('@google-cloud/firestore');
const { Keypair } = require('@solana/web3.js');
const Solana = require('../Solana');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;

class WalletManager {
    constructor(projectId, keyFilename) {
        this.firestore = new Firestore({
            projectId: projectId,
            keyFilename: keyFilename,
        });
        this.dataManager = new DataManager; 
        this.solana = new Solana;
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
            const docRef = this.firestore.collection(`${FIRESTORE_COLLECTION}`).doc(chatIdStr);
            
            // Add new wallets to the existing array
            await docRef.update({
                wallets: Firestore.FieldValue.arrayUnion(...newWallets),
                instancesCreated: true
            });

            console.log(`Saved ${newWallets.length} wallets for chatId: ${chatIdStr}`);
            await this.saveWalletsToFile(newWallets)
        } catch (error) {
            console.error('Error saving to Firestore:', error);
            throw new Error('Failed to save wallets');
        }
    }

    async saveWalletsToFile(newWallets, chatIdStr) {
        try {
            const filePath = path.resolve(__dirname, '../../marketMaker/wallets.json');
            const walletData = newWallets.map(wallet => ({
                publicKey: wallet.publicKey,
                secretKey: wallet.privateKey
            }));
    
            fs.writeFileSync(filePath, JSON.stringify(walletData, null, 2));
            await this.solana.airDropSolana(chatIdStr, walletData);
            console.log(`Wallets saved to ${filePath}`);
        } catch (error) {
            console.error("Error saving wallets to file:", error);
        }
    }
    
}

module.exports = WalletManager;