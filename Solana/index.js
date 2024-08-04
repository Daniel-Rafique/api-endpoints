const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs').promises;
const path = require('path');
const DataManager = require('../database');
const Firestore = require('@google-cloud/firestore');
const { RateLimiter } = require('limiter');
const { Helius } = require('helius-sdk'); // Import Helius SDK

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const ENV_PATH = process.env.ENV;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY; // Your Helius API key

class Solana {
  constructor() {
    this.connection = new Connection(process.env.SOLANA_RPC_ENDPOINT_1, 'confirmed');
    this.dataManager = new DataManager();
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: '.config/firebaseServiceAccountKey.json',
    });
    this.limiter = new RateLimiter({ tokensPerInterval: 10, interval: 'second' }); // Limiting to 10 transactions per second
    this.helius = new Helius(HELIUS_API_KEY); // Initialize Helius
  }

  async airDropSolana(chatId) {
    const chatIdStr = chatId.toString();

    if (!chatIdStr || typeof chatIdStr !== 'string') {
      throw new Error('Invalid chatIdStr');
    }

    const userDocRef = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatIdStr);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      throw new Error('User document does not exist');
    }

    const userData = userDoc.data();
    const senderPrivateKey = userData.walletPk;

    if (!senderPrivateKey) {
      throw new Error('Wallet private key not found in user data');
    }

    try {
      const receiverKeypair = Keypair.fromSecretKey(bs58.decode(senderPrivateKey));
      const receiverBalance = await this.connection.getBalance(receiverKeypair.publicKey);
      console.log('Airdrop Solana, receiver balance:', receiverBalance);

      // Read the newly created wallets from the JSON file
      const filePath = path.resolve(__dirname, `../../${ENV_PATH}/marketMaker/wallets.json`);
      const fileContent = await fs.readFile(filePath, 'utf8');
      const newWallets = JSON.parse(fileContent);
      console.log(newWallets);

      // Calculate 75% of Wallet A's balance
      const amountToDistribute = Math.floor(receiverBalance * 0.75);
      const amountPerWallet = Math.floor(amountToDistribute / newWallets.length);

      // Calculate 25% for KOYNLABS_WALLET
      const amountForKoynlabs = Math.floor(receiverBalance * 0.25);

      const batchSize = parseInt(process.env.BATCH_SIZE, 10); // Number of wallets to process in parallel

      for (let i = 0; i < newWallets.length; i += batchSize) {
        const batch = newWallets.slice(i, i + batchSize);

        await Promise.all(batch.map(async (wallet) => {
          await this.helius.rpc.airdrop(new PublicKey(wallet.publicKey), amountPerWallet);
          await new Promise((resolve, reject) => {
            this.limiter.removeTokens(1, (err, remainingRequests) => {
              if (err) reject(err);
              else resolve(remainingRequests);
            });
          });
        }));
      }

      // Send 25% to KOYNLABS_WALLET
      await this.helius.rpc.airdrop(new PublicKey(KOYNLABS_WALLET), amountForKoynlabs);

      // Update the database flag after successful completion
      await userDocRef.update({
        airDropSolana: true
      });

      console.log('Airdrop completed successfully');
    } catch (error) {
      console.error('Error during airdrop:', error);
      throw error;  // Ensure any error is propagated so it can be handled appropriately
    }
  }
}

module.exports = Solana;