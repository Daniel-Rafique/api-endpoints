const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const fs = require('fs').promises;
const path = require('path');
const bs58 = require('bs58');

const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_2;
const TX_INTERVAL = 1000;
const ENV_PATH = process.env.ENV;

class Distribute {
  constructor() {
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
  }

  async distributeSolana(senderPrivateKey, chatId) {
    try {
      const senderKeypair = Keypair.fromSecretKey(bs58.decode(senderPrivateKey));
      const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);

      const filePath = path.resolve(__dirname, `../../${ENV_PATH}/instances/${chatId}/wallets.json`);
      const fileContent = await fs.readFile(filePath, 'utf8');
      const newWallets = JSON.parse(fileContent);
      
      const amountPerWallet = Math.floor(senderBalance / newWallets.length);

      const dropList = newWallets.map(wallet => ({
        walletAddress: wallet.publicKey,
        numLamports: amountPerWallet,
      }));

      const transactionList = this.generateTransactions(dropList, senderKeypair.publicKey);
      const txResults = await this.executeTransactions(transactionList, senderKeypair);

      return txResults;
    } catch (error) {
      console.error('Error during distribution:', error);
      throw error;
    }
  }

  generateTransactions(dropList, fromWallet) {
    const transactions = [];
    const txInstructions = dropList.map(drop =>
      SystemProgram.transfer({
        fromPubkey: fromWallet,
        toPubkey: new PublicKey(drop.walletAddress),
        lamports: drop.numLamports,
      })
    );

    const batchSize = Math.ceil(txInstructions.length / dropList.length);
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

  async executeTransactions(transactionList, payer) {
    const results = [];
    const staggeredTransactions = transactionList.map((transaction, i) => {
      return new Promise((resolve) => {
        setTimeout(async () => {
          try {
            console.log(`Requesting Transaction ${i + 1}/${transactionList.length}`);
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            const signature = await sendAndConfirmTransaction(this.connection, transaction, [payer]);
            resolve({ status: 'fulfilled', signature });
          } catch (error) {
            resolve({ status: 'rejected', reason: error });
          }
        }, i * TX_INTERVAL);
      });
    });

    results.push(...await Promise.allSettled(staggeredTransactions));
    return results;
  }
}

module.exports = Distribute;
