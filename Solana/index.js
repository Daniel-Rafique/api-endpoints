require('dotenv').config();
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const fs = require('fs').promises;
const path = require('path');
const bs58 = require('bs58');
const { MESSAGES } = require('../constants');
const DataManager = require('../database');
const Firestore = require('@google-cloud/firestore');
const InstanceInitializer = require('../InstanceInitializer');
const Telegram = require('../Telegram');
const BalanceChecker = require('../BalanceChecker');
const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const SOLANA_RPC_ENDPOINT_2 = process.env.SOLANA_RPC_ENDPOINT_2;
const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ENV_PATH = process.env.ENV;
const TX_INTERVAL = 1000;

const SOLANA_CONNECTION = new Connection(SOLANA_RPC_ENDPOINT_2);

class InsufficientBalanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

class Solana {
  constructor() {
    this.connection = new Connection(SOLANA_RPC_ENDPOINT_2, 'confirmed');
    this.dataManager = new DataManager();
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: '.config/firebaseServiceAccountKey.json',
    });
    this.instanceInitializer = new InstanceInitializer();
    this.telegramNotifier = new Telegram(TELEGRAM_TOKEN);
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
    const NUM_DROPS_PER_TX = userData.batchSize;
    const senderPrivateKey = userData.walletPk;

    if (!senderPrivateKey) {
      throw new Error('Wallet private key not found in user data');
    }

    try {
      // Disable BalanceChecker listener
      const balanceChecker = new BalanceChecker(); // Initialize BalanceChecker
      balanceChecker.disableListener();
      const senderKeypair = Keypair.fromSecretKey(bs58.decode(senderPrivateKey));
      const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);
      console.log('Sender balance:', senderBalance);
      this.senderBalance = senderBalance;

      if (senderBalance <= 0) {
        throw new InsufficientBalanceError('Insufficient balance in sender wallet');
      }

      const filePath = path.resolve(__dirname, `../../${ENV_PATH}/instances/${chatId}/wallets.json`);
      const fileContent = await fs.readFile(filePath, 'utf8');
      const newWallets = JSON.parse(fileContent);
      console.log(newWallets);

      const amountToDistribute = Math.floor(senderBalance * 0.75);
      const amountPerWallet = Math.floor(amountToDistribute / newWallets.length);

      const dropList = newWallets.map(wallet => ({
        walletAddress: wallet.publicKey,
        numLamports: amountPerWallet,
      }));

      const transactionList = this.generateTransactions(NUM_DROPS_PER_TX, dropList, senderKeypair.publicKey);
      const txResults = await this.executeTransactions(SOLANA_CONNECTION, transactionList, senderKeypair);

      console.log(txResults);

      const allSuccessful = txResults.every(result => result.status === 'fulfilled');

      if (allSuccessful) {
        await this.sendRemainingToKoynlabsWallet(senderKeypair);

        console.log('Airdrop completed successfully');
        await userDocRef.update({
          distributeSolana: true,
        });

        this.instanceInitializer.initializeMarketMakerInstance(chatId);
      } else {
        console.error('Some transactions failed:', txResults);
        throw new Error('Bulk transactions failed');
      }
    } catch (error) {
      console.error('Error during airdrop:', error);
      if (error instanceof InsufficientBalanceError) {
        console.log('Wallet is empty:', error.message);
        const message = MESSAGES.INSUFFICIENT_SOL(userData.boostCost || 0); // Ensure boostCost is defined
        await this.telegramNotifier.sendTelegramMessage(chatId, message);
      } else {
        console.log(error.message);
      }
    } finally {
      // Re-enable BalanceChecker listener
      balanceChecker.enableListener();
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
    const staggeredTransactions = transactionList.map((transaction, i) => {
      return new Promise((resolve) => {
        setTimeout(async () => {
          console.log(`Requesting Transaction ${i + 1}/${transactionList.length}`);
          const { blockhash } = await solanaConnection.getLatestBlockhash();
          transaction.recentBlockhash = blockhash;
          const signature = await sendAndConfirmTransaction(solanaConnection, transaction, [payer]);
          resolve({ status: 'fulfilled', signature });
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

    const estimatedFee = await this.getEstimatedFee();
    const koynlabsTransaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: new PublicKey(KOYNLABS_WALLET),
        lamports: remainingBalance - estimatedFee
      })
    );

    koynlabsTransaction.feePayer = senderKeypair.publicKey;
    koynlabsTransaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
    koynlabsTransaction.sign(senderKeypair);
    await sendAndConfirmTransaction(this.connection, koynlabsTransaction, [senderKeypair]);
  }

  async getEstimatedFee() {
    const { blockhash } = await this.connection.getLatestBlockhash();
    const dummyTransaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.receiverKeypair.publicKey,
        toPubkey: this.receiverKeypair.publicKey, // Dummy transfer to self
        lamports: 1,
      })
    );

    const message = dummyTransaction.compileMessage();
    const { value } = await this.connection.getFeeForMessage(message);
    return value || 0;
  }
}

module.exports = Solana;