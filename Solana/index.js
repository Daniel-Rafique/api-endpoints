const {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} = require('@solana/web3.js');
const fs = require('fs').promises;
const path = require('path');
const bs58 = require('bs58');
const DataManager = require('../database');
const Firestore = require('@google-cloud/firestore');
const InstanceInitializer = require('../InstanceInitializer');
require('dotenv').config();

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const SOLANA_RPC_ENDPOINT_2 = process.env.SOLANA_RPC_ENDPOINT_2;
const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
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
    this.instanceInitializer = new InstanceInitializer();
  }

  async distributeSolana(chatId) {
    const chatIdStr = chatId.toString();

    if (!chatIdStr || typeof chatIdStr !== 'string') {
      throw new Error('Invalid chatIdStr');
    }

    const userDocRef = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatIdStr);
    const userDoc = await userDocRef.get();
    const NUM_DROPS_PER_TX = userDoc.data().batchSize; // Ensure the batch size is fetched from the document

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

      // Check if all transactions were successful
      const allSuccessful = txResults.every(result => result.status === 'fulfilled');

      if (allSuccessful) {
        // Send the remaining balance to KOYNLABS_WALLET
        await this.sendRemainingToKoynlabsWallet(senderKeypair);

        console.log('Airdrop completed successfully');
        // Update the database flag after successful completion
        await userDocRef.update({
          distributeSolana: true,
        });

        // Initialize instances.
        this.instanceInitializer.initializeMarketMakerInstance(chatId);
      } else {
        console.error('Some transactions failed:', txResults);
        throw new Error('Bulk transactions failed');
      }
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

  async sendRemainingToKoynlabsWallet(senderKeypair) {
    const remainingBalance = await this.connection.getBalance(senderKeypair.publicKey);

    if (remainingBalance <= 0) {
      throw new Error('No remaining balance to send to KOYNLABS_WALLET');
    }

    const koynlabsTransaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: new PublicKey(KOYNLABS_WALLET),
        lamports: remainingBalance - 5000, // Adjust for transaction fee
      })
    );

    koynlabsTransaction.feePayer = senderKeypair.publicKey;
    koynlabsTransaction.recentBlockhash = (await this.connection.getRecentBlockhash()).blockhash;
    koynlabsTransaction.sign(senderKeypair);
    await sendAndConfirmTransaction(this.connection, koynlabsTransaction, [senderKeypair]);
  }
}

module.exports = Solana;