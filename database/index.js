require('dotenv').config();
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
class DataManager {

  async getCollection(chatId) {
    try{
      const doc = await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).get();
      if(doc.exists){
        return doc.data();
      }
      return null;
    }catch(error){
      console.error('Error getting collection:', error);
    }
  }
}

module.exports = DataManager;
