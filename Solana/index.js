const {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} = require('@solana/web3.js');
const fs = require('fs').promises;
const bs58 = require('bs58');
const DataManager = require('../database');
const Firestore = require('@google-cloud/firestore');
require('dotenv').config();

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const SOLANA_RPC_ENDPOINT_2 = process.env.SOLANA_RPC_ENDPOINT_2;
const ENV_PATH = process.env.ENV;
const TX_INTERVAL = 1000;

const SOLANA_CONNECTION = new Connection(SOLANA_RPC_ENDPOINT_2);

class Solana {
  constructor() {
    this.connection = new Connection(SOLANA_RPC_ENDPOINT_2, 'confirmed');
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
    const NUM_DROPS_PER_TX = userDocRef.batchSize || 10;

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

      // Calculate the amount to distribute per wallet
      const amountToDistribute = Math.floor(senderBalance * 0.75);
      const amountPerWallet = Math.floor(amountToDistribute / newWallets.length);

      const dropList = newWallets.map(wallet => ({
        walletAddress: wallet.publicKey,
        numLamports: amountPerWallet,
      }));

      const transactionList = this.generateTransactions(NUM_DROPS_PER_TX, dropList, senderKeypair.publicKey);
      const txResults = await this.executeTransactions(SOLANA_CONNECTION, transactionList, senderKeypair);

      console.log(txResults);

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

  generateTransactions(batchSize, dropList, fromWallet) {
    const transactions = [];
    const txInstructions = dropList.map(drop => 
      SystemProgram.transfer({
        fromPubkey: fromWallet,
        toPubkey: new PublicKey(drop.walletAddress),
        lamports: drop.numLamports,
      })
    );

    const numTransactions = Math.ceil(txInstructions.length / batchSize);
    for (let i = 0; i < numTransactions; i++) {
      const transaction = new Transaction();
      const lowerIndex = i * batchSize;
      const upperIndex = (i + 1) * batchSize;
      for (let j = lowerIndex; j < upperIndex; j++) {
        if (txInstructions[j]) transaction.add(txInstructions[j]);
      }
      transactions.push(transaction);
    }
    return transactions;
  }

  async executeTransactions(solanaConnection, transactionList, payer) {
    const results = [];
    const staggeredTransactions = transactionList.map((transaction, i, allTx) => {
      return new Promise((resolve) => {
        setTimeout(async () => {
          console.log(`Requesting Transaction ${i + 1}/${allTx.length}`);
          const { blockhash } = await solanaConnection.getLatestBlockhash();
          transaction.recentBlockhash = blockhash;
          const signature = await sendAndConfirmTransaction(solanaConnection, transaction, [payer]);
          resolve(signature);
        }, i * TX_INTERVAL);
      });
    });

    results.push(...await Promise.allSettled(staggeredTransactions));
    return results;
  }
}

module.exports = Solana;