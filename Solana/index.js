const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs').promises;
const path = require('path');
const DataManager = require('../database');
const Firestore = require('@google-cloud/firestore');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const ENV_PATH = process.env.ENV;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE, 10) || 10; // Number of transactions per batch

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
      console.log('Sender balance:', senderBalance);

      // Read the newly created wallets from the JSON file
      const filePath = path.resolve(__dirname, `../../${ENV_PATH}/marketMaker/wallets.json`);
      const fileContent = await fs.readFile(filePath, 'utf8');
      const newWallets = JSON.parse(fileContent);
      console.log(newWallets);

      // Calculate 75% of Wallet A's balance
      const amountToDistribute = Math.floor(senderBalance * 0.75);
      const amountPerWallet = Math.floor(amountToDistribute / newWallets.length);

      // Calculate 25% for KOYNLABS_WALLET
      const amountForKoynlabs = Math.floor(senderBalance * 0.25);

      console.log(`Amount to distribute: ${amountToDistribute}`);
      console.log(`Amount per wallet: ${amountPerWallet}`);
      console.log(`Amount for KOYNLABS_WALLET: ${amountForKoynlabs}`);

      // Create and send transactions in batches
      for (let i = 0; i < newWallets.length; i += BATCH_SIZE) {
        const batch = newWallets.slice(i, i + BATCH_SIZE);
        const transactions = [];

        for (const wallet of batch) {
          const transaction = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: senderKeypair.publicKey,
              toPubkey: new PublicKey(wallet.publicKey),
              lamports: amountPerWallet,
            })
          );
          transaction.feePayer = senderKeypair.publicKey;
          transactions.push(transaction);
        }

        // Sign and send the transactions
        const { blockhash } = await this.connection.getRecentBlockhash();
        const signedTransactions = transactions.map(transaction => {
          transaction.recentBlockhash = blockhash;
          transaction.sign(senderKeypair);
          return sendAndConfirmTransaction(this.connection, transaction, [senderKeypair]);
        });

        await Promise.all(signedTransactions);
      }

      // Send 25% to KOYNLABS_WALLET
      const koynlabsTransaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: senderKeypair.publicKey,
          toPubkey: new PublicKey(KOYNLABS_WALLET),
          lamports: amountForKoynlabs,
        })
      );
      koynlabsTransaction.feePayer = senderKeypair.publicKey;
      koynlabsTransaction.recentBlockhash = (await this.connection.getRecentBlockhash()).blockhash;
      koynlabsTransaction.sign(senderKeypair);
      await sendAndConfirmTransaction(this.connection, koynlabsTransaction, [senderKeypair]);

      // Update the database flag after successful completion
      await userDocRef.update({
        airDropSolana: true,
      });

      console.log('Airdrop completed successfully');
    } catch (error) {
      console.error('Error during airdrop:', error);
      throw error; // Ensure any error is propagated so it can be handled appropriately
    }
  }
}

module.exports = Solana;