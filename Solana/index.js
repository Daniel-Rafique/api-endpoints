const { Connection, PublicKey, Keypair, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs').promises;
const path = require('path');
const DataManager = require('../database');
const Firestore = require('@google-cloud/firestore');
const { RateLimiter } = require('limiter');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const ENV_PATH = process.env.ENV;

class Solana {
  constructor() {
    this.connection = new Connection(process.env.SOLANA_RPC_ENDPOINT_1, 'confirmed');
    this.dataManager = new DataManager();
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: '.config/firebaseServiceAccountKey.json',
    });
    this.limiter = new RateLimiter({ tokensPerInterval: 10, interval: 'second' }); // Limiting to 10 transactions per second
  }

  async distributeSolana(chatId) {
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
      const senderKeypair = Keypair.fromSecretKey(bs58.decode(senderPrivateKey));
      const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);
      console.log('Distribute Solana, sender balance:', senderBalance);

      // Read the recipient wallets from the JSON file
      const filePath = path.resolve(__dirname, `../../${ENV_PATH}/marketMaker/wallets.json`);
      const fileContent = await fs.readFile(filePath, 'utf8');
      const recipientWallets = JSON.parse(fileContent);
      console.log(recipientWallets);

      // Calculate 75% of sender's balance
      const amountToDistribute = Math.floor(senderBalance * 0.75);
      const amountPerWallet = Math.floor(amountToDistribute / recipientWallets.length);

      // Calculate 25% for KOYNLABS_WALLET
      const amountForKoynlabs = Math.floor(senderBalance * 0.25);

      console.log(`Amount to distribute: ${amountToDistribute}`);
      console.log(`Amount per wallet: ${amountPerWallet}`);
      console.log(`Amount for KOYNLABS_WALLET: ${amountForKoynlabs}`);

      const batchSize = parseInt(process.env.BATCH_SIZE, 10); // Number of wallets to process in parallel

      for (let i = 0; i < recipientWallets.length; i += batchSize) {
        const batch = recipientWallets.slice(i, i + batchSize);

        await Promise.all(batch.map(async (wallet) => {
          try {
            const signature = await this.sendSol(senderKeypair, new PublicKey(wallet.publicKey), amountPerWallet);
            console.log(`Sent ${amountPerWallet} lamports to ${wallet.publicKey}. Signature: ${signature}`);

            await new Promise((resolve, reject) => {
              this.limiter.removeTokens(1, (err, remainingRequests) => {
                if (err) reject(err);
                else resolve(remainingRequests);
              });
            });
          } catch (error) {
            console.error(`Error sending to ${wallet.publicKey}:`, error.message);
          }
        }));
      }

      // Send 25% to KOYNLABS_WALLET
      try {
        const signature = await this.sendSol(senderKeypair, new PublicKey(KOYNLABS_WALLET), amountForKoynlabs);
        console.log(`Sent ${amountForKoynlabs} lamports to KOYNLABS_WALLET. Signature: ${signature}`);
      } catch (error) {
        console.error(`Error sending to KOYNLABS_WALLET:`, error);
      }

      // Update the database flag after successful completion
      await userDocRef.update({
        distributeSolana: true
      });

      console.log('Distribution completed successfully');
    } catch (error) {
      console.error('Error during distribution:', error.message);
      throw error;
    }
  }

  async sendSol(senderKeypair, recipientPublicKey, amount, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: senderKeypair.publicKey,
            toPubkey: recipientPublicKey,
            lamports: amount,
          })
        );
  
        // Get a recent blockhash
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = senderKeypair.publicKey;
  
        // Sign transaction, broadcast, and confirm
        transaction.sign(senderKeypair);
        const rawTransaction = transaction.serialize();
        const signature = await this.connection.sendRawTransaction(rawTransaction, {
          skipPreflight: true,
          preflightCommitment: 'confirmed',
        });
  
        // Wait for confirmation with a longer timeout
        const confirmation = await this.connection.confirmTransaction({
          signature,
          blockhash,
          lastValidBlockHeight: await this.connection.getBlockHeight() + 150
        }, 'confirmed');
  
        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${confirmation.value.err}`);
        }
  
        console.log(`Transaction ${signature} confirmed`);
        return signature;
      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed:`, error);
        if (attempt === retries - 1) {
          throw error; // Rethrow the error if this was the last attempt
        }
        // Wait for a short time before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}

module.exports = Solana;