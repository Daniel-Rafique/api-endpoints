const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const path = require('path');
const os = require('os');
const Send = require('./Send');
const Distribute = require('./Distribute');
const { Firestore } = require('@google-cloud/firestore');
const Telegram = require('../Telegram');
const bs58 = require('bs58');
const { MESSAGES } = require('../constants');
const redis = require('redis');
const client = redis.createClient();

client.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  await client.connect();
})();

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_2;

class Solana {
  constructor(chatId) {
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    this.chatId = chatId;
    this.telegramNotifier = new Telegram(process.env.TELEGRAM_TOKEN);
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: path.join(os.homedir(), process.env.FIRESTORE_KEYSTORE, '.config/firebaseServiceAccountKey.json'),
    });
  }

  async distributeSolana(chatId) {
    try {
      const userData = await this.dataManager.getCollection(chatId.toString());

      if (!userData || !userData.walletPk) {
        throw new Error('User data or wallet private key not found');
      }

      let updatedBalance;

      const sendInstance = new Send(chatId);

      if (!userData.commissionPaid) {
        updatedBalance = await sendInstance.sendToKoynlabsWallet(userData.walletPk, userData);
        // Mark the commission as paid
        await this.firestore.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).update({ commissionPaid: true });
      } else {
        const senderKeypair = Keypair.fromSecretKey(bs58.decode(userData.walletPk));
        updatedBalance = await this.connection.getBalance(senderKeypair.publicKey);
      }

      // After sending the commission, proceed to distribute the remaining Solana if there is a balance left
      if (updatedBalance > 0) {
        const distributeInstance = new Distribute(chatId);
        const results = await distributeInstance.distributeSolana(userData.walletPk, chatId, userData);
        console.log('Distribution results:', results);

        const message = MESSAGES.DEPLOYMENT(updatedBalance);
        if (this.shouldSendMessage(chatId, message)) {
          await this.telegramNotifier.sendTelegramMessage(chatId, message);
        }
      } else {
        console.log('No balance left to distribute.');
        const userDocRef = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatId.toString());
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) {
          throw new Error('User document does not exist');
        }
        await userDocRef.update({ distributeSolana: false });
      }
    } catch (error) {
      console.error('Error during airdrop:', error);
      if (error instanceof InsufficientBalanceError) {
        console.log('Wallet is empty:', error.message);
        const message = MESSAGES.TOPUP_SOL(userData.boostCost || 0);
        if (this.shouldSendMessage(chatId, message)) {
          await this.telegramNotifier.sendTelegramMessage(chatId, message);
        }
      } else {
        console.log(error.message);
      }
    }
  }
}

module.exports = Solana;
