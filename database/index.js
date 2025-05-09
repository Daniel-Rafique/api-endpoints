require('dotenv').config();
const admin = require('firebase-admin');
const db = admin.firestore();
const EventEmitter = require('events');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const getServerTimestamp = () => admin.firestore.FieldValue.serverTimestamp();

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

  async saveSenderWallet(chatId, senderWallet, licenseKey, durationMonths = 1) {
    try {
      // Calculate expiration date based on duration months
      const currentDate = new Date();
      const expirationDate = new Date(currentDate);
      expirationDate.setMonth(currentDate.getMonth() + durationMonths);
      
      await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).set({
        senderWallet: senderWallet,
        licenseKey: licenseKey,
        licenseStatus: 'VALID',
        licenseDurationMonths: durationMonths,
        licenseCreatedAt: getServerTimestamp(),
        licenseExpiresAt: admin.firestore.Timestamp.fromDate(expirationDate),
        transactionSignature: transactionSignature
      }, { merge: true });
      
      console.log(`Saved senderWallet and license key for chat ID ${chatId} (valid for ${durationMonths} months)`);
      return true;
    } catch (error) {
      console.error(`Error saving senderWallet and license key for ${chatId}:`, error);
      return false;
    }
  }

  async validateLicenseKey(chatId, licenseKey) {
    try {
      const doc = await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).get();
      
      if (!doc.exists) {
        console.log(`No document found for chat ID ${chatId}`);
        return false;
      }
      
      const data = doc.data();
      
      // Check if license key exists and matches
      if (!data.licenseKey || data.licenseKey !== licenseKey) {
        console.log(`Invalid license key for chat ID ${chatId}`);
        return false;
      }
      
      // Check if license is expired
      if (data.licenseExpiresAt) {
        const expiryDate = data.licenseExpiresAt.toDate();
        if (expiryDate < new Date()) {
          console.log(`License key expired for chat ID ${chatId}`);
          
          // Update the license status to INVALID
          await this.updateLicenseStatus(chatId, 'INVALID', 'License expired');
          
          return false;
        }
      }
      
      console.log(`License key validated for chat ID ${chatId}`);
      return true;
    } catch (error) {
      console.error(`Error validating license key for ${chatId}:`, error);
      return false;
    }
  }
  
  async updateLicenseStatus(chatId, status, reason = '') {
    try {
      await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).set({
        licenseStatus: status,
        licenseStatusReason: reason,
        licenseStatusUpdatedAt: getServerTimestamp()
      }, { merge: true });
      
      console.log(`Updated license status to ${status} for chat ID ${chatId}: ${reason}`);
      return true;
    } catch (error) {
      console.error(`Error updating license status for ${chatId}:`, error);
      return false;
    }
  }
  
  async checkExpiredLicenses() {
    try {
      const now = new Date();
      
      // Query for licenses that are expired but still marked as VALID
      const snapshot = await db.collection(FIRESTORE_COLLECTION)
        .where('licenseStatus', '==', 'VALID')
        .where('licenseExpiresAt', '<', admin.firestore.Timestamp.fromDate(now))
        .get();
      
      if (snapshot.empty) {
        console.log('No expired licenses found.');
        return { updated: 0 };
      }
      
      let updatedCount = 0;
      
      // Update each expired license
      for (const doc of snapshot.docs) {
        const chatId = doc.id;
        await this.updateLicenseStatus(chatId, 'INVALID', 'License expired automatically');
        updatedCount++;
      }
      
      console.log(`Updated ${updatedCount} expired licenses to INVALID status.`);
      return { updated: updatedCount };
    } catch (error) {
      console.error('Error checking expired licenses:', error);
      return { error: error.message };
    }
  }

  async getLicenseInfo(chatId) {
    try {
      const doc = await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).get();
      
      if (!doc.exists) {
        return null;
      }
      
      const data = doc.data();
      
      // Return license information
      return {
        licenseKey: data.licenseKey || null,
        licenseStatus: data.licenseStatus || 'INVALID',
        licenseCreatedAt: data.licenseCreatedAt ? data.licenseCreatedAt.toDate() : null,
        licenseExpiresAt: data.licenseExpiresAt ? data.licenseExpiresAt.toDate() : null,
        senderWallet: data.senderWallet || null
      };
    } catch (error) {
      console.error(`Error getting license info for ${chatId}:`, error);
      return null;
    }
  }

  async setMode(chatId, mode) {
    try {
      await db.collection(FIRESTORE_COLLECTION).doc(chatId.toString()).set({
        mode: mode,
        timestamp: getServerTimestamp()
      }, { merge: true });
      console.log(`Set mode to ${mode} for chat ID ${chatId}`);
      this.emit('modeChanged', chatId, mode);
    } catch (error) {
      console.error('Error setting mode:', error);
    }
  }
}

const dataManagerInstance = new DataManager();
module.exports = dataManagerInstance;