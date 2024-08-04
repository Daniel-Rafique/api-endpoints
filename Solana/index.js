const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
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
    this.connection = new Connection(process.env.JITO_API_URL, 'confirmed');
    this.dataManager = new DataManager();
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: '.config/firebaseServiceAccountKey.json',
    });
    this.limiter = new RateLimiter({ tokensPerInterval: 10, interval: 'second' }); // Limiting to 10 transactions per second
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
        const transaction = new Transaction();
        await Promise.all(batch.map(async (wallet) => {
          const instruction = SystemProgram.transfer({
            fromPubkey: receiverKeypair.publicKey,
            toPubkey: new PublicKey(wallet.publicKey),
            lamports: amountPerWallet
          });
          transaction.add(instruction);
        }));

        await new Promise((resolve, reject) => {
          this.limiter.removeTokens(1, (err, remainingRequests) => {
            if (err) reject(err);
            else resolve(remainingRequests);
          });
        });

        await this.sendAndRetryTransaction(transaction, receiverKeypair);
      }

      // Send 25% to KOYNLABS_WALLET
      const koynlabsTransaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: receiverKeypair.publicKey,
          toPubkey: new PublicKey(KOYNLABS_WALLET),
          lamports: amountForKoynlabs
        })
      );

      await this.sendAndRetryTransaction(koynlabsTransaction, receiverKeypair);

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

  async sendAndRetryTransaction(transaction, signer) {
    let retries = 5;
    while (retries > 0) {
      try {
        await this.sendAndConfirmTransaction(transaction, signer);
        return;
      } catch (error) {
        if (error.message.includes('block height exceeded')) {
          console.log('Transaction expired, retrying with updated block height');
          retries -= 1;
          if (retries === 0) throw error; // Rethrow if retries exhausted
          const { blockhash } = await this.connection.getRecentBlockhash();
          transaction.recentBlockhash = blockhash;
          transaction.sign(signer);
        } else {
          throw error;
        }
      }
    }
  }

  async sendAndConfirmTransaction(transaction, signer) {
    const { blockhash } = await this.connection.getRecentBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = signer.publicKey;

    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [signer],
      { commitment: 'confirmed' }
    );

    console.log('Transaction confirmed:', signature);
  }
}

module.exports = Solana;