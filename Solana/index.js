const { Connection, PublicKey, Keypair, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs').promises;
const path = require('path');
const DataManager = require('../database');
const Firestore = require('@google-cloud/firestore');

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
  }

  async distributeSolana(chatId) {
    console.log(`Starting distribution for chatId: ${chatId}`);
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

      const filePath = path.resolve(__dirname, `../../${ENV_PATH}/marketMaker/wallets.json`);
      const fileContent = await fs.readFile(filePath, 'utf8');
      const recipientWallets = JSON.parse(fileContent);

      console.log(`Total recipient wallets: ${recipientWallets.length}`);

      const amountToDistribute = Math.floor(senderBalance * 0.75);
      const amountPerWallet = Math.floor(amountToDistribute / recipientWallets.length);
      const amountForKoynlabs = Math.floor(senderBalance * 0.25);

      console.log(`Amount to distribute: ${amountToDistribute}`);
      console.log(`Amount per wallet: ${amountPerWallet}`);
      console.log(`Amount for KOYNLABS_WALLET: ${amountForKoynlabs}`);

      const batchSize = 5; // Reduced batch size for better manageable
      const results = [];

      for (let i = 0; i < recipientWallets.length; i += batchSize) {
        console.log(`Processing batch ${i / batchSize + 1}`);
        const batch = recipientWallets.slice(i, i + batchSize);
        const batchResults = await this.processBatch(senderKeypair, batch, amountPerWallet);
        results.push(...batchResults);
        
        console.log(`Batch ${i / batchSize + 1} results:`, batchResults);
        
        // Add a delay between batches to avoid overwhelming the network
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // Send to KOYNLABS_WALLET
      console.log(`Sending to KOYNLABS_WALLET: ${KOYNLABS_WALLET}`);
      const koynlabsResult = await this.sendSol(senderKeypair, new PublicKey(KOYNLABS_WALLET), amountForKoynlabs);
      results.push(koynlabsResult);

      const successfulTransactions = results.filter(r => r.success).length;
      console.log(`Successfully sent to ${successfulTransactions} out of ${results.length} wallets`);

      await userDocRef.update({ distributeSolana: true });
      
      return results;
    } catch (error) {
      console.error('Error during distribution:', error.message);
      throw error;
    }
  }

  async processBatch(senderKeypair, batch, amountPerWallet) {
    return Promise.all(batch.map(wallet => 
      this.sendSol(senderKeypair, new PublicKey(wallet.publicKey), amountPerWallet)
    ));
  }

  async sendSol(senderKeypair, recipientPublicKey, amount, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        console.log(`Attempt ${attempt + 1} to send ${amount} lamports to ${recipientPublicKey.toBase58()}`);
        
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: senderKeypair.publicKey,
            toPubkey: recipientPublicKey,
            lamports: amount,
          })
        );

        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = senderKeypair.publicKey;
        transaction.sign(senderKeypair);

        const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
          maxRetries: 5,
        });

        console.log(`Transaction sent. Signature: ${signature}`);

        const result = await this.connection.confirmTransaction({
          signature,
          blockhash,
          lastValidBlockHeight,
        });

        if (result.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
        }

        console.log(`Transaction ${signature} confirmed for ${recipientPublicKey.toBase58()}`);
        return { success: true, signature, recipient: recipientPublicKey.toBase58() };
      } catch (error) {
        console.error(`Attempt ${attempt + 1} failed for ${recipientPublicKey.toBase58()}:`, error);
        if (attempt === retries - 1) {
          return { success: false, error: error.message, recipient: recipientPublicKey.toBase58() };
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
}

module.exports = Solana;