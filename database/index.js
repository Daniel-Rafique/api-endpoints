require('dotenv').config();
const admin = require('firebase-admin');
const db = admin.firestore();

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
console.log(FIRESTORE_COLLECTION);

class DataManager {

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

  async saveTransaction(chatId, signature, walletBPublicKeyString, amount){
    try {
      await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).set({
        signature: signature,
        walletBPublicKey: walletBPublicKeyString,
        amount: amount
      }, { merge: true });
      console.log(`Saved holder_boost for chat ID ${chatId}`);
    }catch(error){
      console.error(`Error saving holder_boost for ${chatId}:`, error);
    }
  }
}

module.exports = DataManager;