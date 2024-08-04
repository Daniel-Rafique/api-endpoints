const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs').promises;
const path = require('path');
const DataManager = require('../database');
const Firestore = require('@google-cloud/firestore');
const axios = require('axios'); // For making HTTP requests

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const ENV_PATH = process.env.ENV;
const JITO_RPC_ENDPOINT = process.env.JITO_API_URL; // Replace with the actual Jito Labs RPC endpoint

class Solana {
  constructor() {
    this.connection = new Connection(process.env.SOLANA_RPC_ENDPOINT_1, 'confirmed');
    this.dataManager = new DataManager();
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: '.config/firebaseServiceAccountKey.json',
    });
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
        const transactions = await Promise.all(batch.map(async (wallet) => {
          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: receiverKeypair.publicKey,
              toPubkey: new PublicKey(wallet.publicKey),
              lamports: amountPerWallet
            })
          );

          const { blockhash } = await this.connection.getRecentBlockhash();
          transaction.recentBlockhash = blockhash;
          transaction.feePayer = receiverKeypair.publicKey;
          transaction.sign(receiverKeypair);

          return transaction;
        }));

        await this.sendBundle(transactions);
      }

      // Send 25% to KOYNLABS_WALLET
      const koynlabsTransaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: receiverKeypair.publicKey,
          toPubkey: new PublicKey(KOYNLABS_WALLET),
          lamports: amountForKoynlabs
        })
      );

      const { blockhash: koynlabsBlockhash } = await this.connection.getRecentBlockhash();
      koynlabsTransaction.recentBlockhash = koynlabsBlockhash;
      koynlabsTransaction.feePayer = receiverKeypair.publicKey;
      koynlabsTransaction.sign(receiverKeypair);

      await this.sendBundle([koynlabsTransaction]);

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

  async sendBundle(transactions) {
    const serializedTransactions = transactions.map(tx => tx.serialize().toString('base64'));
    const bundleRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [serializedTransactions],
    };

    try {
      const response = await axios.post(JITO_RPC_ENDPOINT, bundleRequest);
      if (response.data.error) {
        throw new Error(response.data.error.message);
      }
      console.log('Bundle sent:', response.data.result);
    } catch (error) {
      console.error('Error sending bundle:', error);
      throw error;
    }
  }
}

module.exports = Solana;
