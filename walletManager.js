const bs58 = require('bs58');
const { Firestore } = require('@google-cloud/firestore');
const { Keypair } = require('@solana/web3.js');

class WalletManager {
    constructor(projectId, keyFilename) {
        this.firestore = new Firestore({
            projectId: projectId,
            keyFilename: keyFilename,
        });
    }

    createSolanaWallets(count) {
        console.log("Creating wallets");
        const wallets = [];
        for (let i = 0; i < count; i++) {
            const keypair = Keypair.generate();
            const privateKey = bs58.encode(Buffer.from(keypair.secretKey)); // Ensure Buffer.from is used
            const publicKey = keypair.publicKey.toString();
            wallets.push({ privateKey, publicKey });
        }
        return wallets;
    }

    async saveWallets(chatId, boostType, newWallets) {
        try {
            console.log("Saving wallets");
            if (!chatId) {
                throw new Error('Invalid chatId');
            }
            const chatIdStr = chatId.toString(); // Ensure chatId is a string
            const docRef = this.firestore.collection('mm').doc(chatIdStr);
            
            // Add new wallets to the existing array
            await docRef.update({
                wallets: Firestore.FieldValue.arrayUnion(...newWallets),
                boostType: boostType,
                instancesCreated: true
            });

            console.log(`Saved ${newWallets.length} wallets for chatId: ${chatIdStr}`);
        } catch (error) {
            console.error('Error saving to Firestore:', error);
            throw new Error('Failed to save wallets');
        }
    }
}

module.exports = WalletManager;