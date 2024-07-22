const { Firestore } = require('@google-cloud/firestore');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

class WalletManager {
    constructor(projectId, keyFilename) {
        this.firestore = new Firestore({
            projectId: projectId,
            keyFilename: keyFilename,
        });
    }

    createSolanaWallets(count) {
        const wallets = [];
        for (let i = 0; i < count; i++) {
            const keypair = Keypair.generate();
            const privateKey = bs58.encode(keypair.secretKey);
            const publicKey = keypair.publicKey.toString();
            wallets.push({ privateKey, publicKey });
        }
        return wallets;
    }

    async saveWallets(chatId, boostType, wallets) {
        try {
            await this.firestore.collection('wallets').doc(chatId).set({
                chatId: chatId,
                boostType: boostType,
                wallets: wallets
            });
            console.log(`Saved ${wallets.length} wallets for chatId: ${chatId}`);
        } catch (error) {
            console.error('Error saving to Firestore:', error);
            throw new Error('Failed to save wallets');
        }
    }
}

module.exports = WalletManager;
