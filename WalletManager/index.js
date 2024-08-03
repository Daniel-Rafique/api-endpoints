require('dotenv').config();
const bs58 = require('bs58');
const DataManager = require('../Database');
const { Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const Solana = require('../Solana');

class WalletManager {
    constructor() {
        this.dataManager = new DataManager; 
        this.solana = new Solana();
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
            if (!chatId) {
                throw new Error('Invalid chatId');
            }
            const chatIdStr = chatId.toString(); // Ensure chatId is a string
            const data = this.dataManager.getCollection(chatIdStr);
            
            // Add new wallets to the existing array
            await data.update({
                wallets: this.createSolanaWallets.arrayUnion(...newWallets),
                instancesCreated: true
            });

            console.log(`Saved ${newWallets.length} wallets for chatId: ${chatIdStr}`);
            this.saveWalletsToFile(newWallets, data)
        } catch (error) {
            console.error('Error saving to Firestore:', error);
            throw new Error('Failed to save wallets');
        }
    }
    
    async saveWalletsToFile(newWallets, data) {
        try {
            const filePath = path.resolve(__dirname, './marketMaker/wallets.json');
            const walletData = newWallets.map(newWallets => ({
                publicKey: newWallets.publicKey.toBase58(),
                secretKey: bs58.encode(newWallets.secretKey)
            }));
    
            await fs.writeFileSync(filePath, JSON.stringify(walletData, null, 2));
            await this.solana.airDropSolana(data);

            console.log(`Wallets saved to ${filePath}`);
        } catch (error) {
            console.error("Error saving wallets to file:", error);
        }
    }
}

module.exports = WalletManager;