require('dotenv').config();
const admin = require('firebase-admin');
const db = admin.firestore();
const EventEmitter = require('events');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
console.log(FIRESTORE_COLLECTION);

class DataManager extends EventEmitter {

  async getCollection(chatId) {

    try {
      const doc = await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).get();
      if (doc.exists) {
        return doc.data();
      }
      return null;
    } catch (error) {
      console.error('Error getting collection:', error);
    }
  }

  async updateCollection(chatId, updateData) {

    if (!chatId || typeof chatId !== 'string') {
      throw new Error('Invalid chatId. It must be a non-empty string.');
    }

    if (!updateData || typeof updateData !== 'object' || Object.keys(updateData).length === 0) {
      throw new Error('Invalid updateData. It must be a non-empty object.');
    }

    try {
      const doc = db.collection(FIRESTORE_COLLECTION).doc(chatId.toString());
      await doc.set(updateData, { merge: true });

      console.log(`Successfully updated document for chat ID ${chatId}`);
      return true;
    } catch (error) {
      console.error(`Error updating document for chat ID ${chatId}:`, error);
      throw error; // Re-throw the error for higher-level error handling
    }
  }

  async getTransaction(chatId) {
    try {
      const doc = await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).get();
      if (doc.exists) {
        return doc.data();
      }
      return null;
    } catch (error) {
      console.error('Error getting transaction:', error);
    }
  }

  async saveTransaction(chatId, signature, senderPublicKeyString, amount) {
    console.log(`Saving transaction info for chat ID ${chatId}`);
    try {
      await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).set({
        signature: signature,
        senderPublicKey: senderPublicKeyString,
        balance: amount
      }, { merge: true });
      console.log(`Saved transaction info for chat ID ${chatId}`);
    } catch (error) {
      console.error(`Error saving info for ${chatId}:`, error);
    }
  }

  async saveTransactionComplete(chatId, transactionComplete) {
    try {
      await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString(), transactionComplete).set({
        complete: transactionComplete
      }, { merge: true });
      console.log(`Saved transaction info for chat ID ${chatId}`);
    } catch (error) {
      console.error(`Error saving info for ${chatId}:`, error);
    }
  }

  async saveSenderWallet(chatId, senderWallet) {
    try {
      await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).set({
        senderWallet: senderWallet
      }, { merge: true });
      console.log(`Saved senderWallet for chat ID ${chatId}`);
    } catch (error) {
      console.error(`Error saving senderWallet for ${chatId}:`, error);
    }
  }

  async setMode(chatId, mode) {
    try {
      console.log(`Setting mode for ${chatId} to ${mode}`);

      // Your existing code to set the mode in the database
      const result = await this.collection.updateOne(
        { chatId },
        { $set: { mode } },
        { upsert: true }
      );

      // Emit an event when mode changes
      this.emit('modeChanged', chatId, mode);

      return result;
    } catch (error) {
      console.error('Error setting mode:', error);
      throw error;
    }
  }
}

module.exports = DataManager;