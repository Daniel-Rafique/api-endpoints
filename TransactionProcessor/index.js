// TransactionProcessor.js
const { PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');

class TransactionProcessor {
  constructor(connection, walletAKeypair) {
    this.connection = connection;
    this.walletAKeypair = walletAKeypair;
  }

  async getTransactionHistory(walletAPublicKeyString) {
    try {
      const walletAPublicKey = new PublicKey(walletAPublicKeyString);
      const signatures = await this.connection.getSignaturesForAddress(walletAPublicKey, { limit: 1 });
      const confirmedTransaction = await this.connection.getTransaction(signatures[0].signature);
      return confirmedTransaction;
    } catch (error) {
      console.error('Error fetching transaction history:', error);
      throw error;
    }
  }

  async returnSolToWalletB(walletBPublicKeyString, solBalanceA) {
    try {
      const walletBPublicKey = new PublicKey(walletBPublicKeyString);
      const lamportsToSend = (solBalanceA * 1_000_000_000) - 5000; // Leave some lamports for fees
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.walletAKeypair.publicKey,
          toPubkey: walletBPublicKey,
          lamports: lamportsToSend
        })
      );

      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [this.walletAKeypair]
      );

      return signature;
    } catch (error) {
      console.error('Error returning SOL to Wallet B:', error);
      throw error;
    }
  }
}

module.exports = TransactionProcessor;