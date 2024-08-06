require('dotenv').config();
const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58');

const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_2;

class Send {
  constructor() {
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
  }

  async sendToKoynlabsWallet(senderPrivateKey) {
    try {
      const senderKeypair = Keypair.fromSecretKey(bs58.decode(senderPrivateKey));
      const senderBalance = await this.connection.getBalance(senderKeypair.publicKey);
      
      if (senderBalance <= 0) {
        throw new Error('Insufficient balance in sender wallet');
      }

      const amountToSend = Math.floor(senderBalance * 0.25);
      const estimatedFee = await this.getEstimatedFee(senderKeypair);

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: senderKeypair.publicKey,
          toPubkey: new PublicKey(KOYNLABS_WALLET),
          lamports: amountToSend - estimatedFee,
        })
      );

      transaction.feePayer = senderKeypair.publicKey;
      transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
      transaction.sign(senderKeypair);

      await sendAndConfirmTransaction(this.connection, transaction, [senderKeypair]);
      
      const updatedBalance = await this.connection.getBalance(senderKeypair.publicKey);
      return updatedBalance;
    } catch (error) {
      console.error('Error sending to KOYNLABS_WALLET:', error);
      throw error;
    }
  }

  async getEstimatedFee(senderKeypair) {
    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new Transaction({
      recentBlockhash: blockhash,
      feePayer: senderKeypair.publicKey
    }).add(
      SystemProgram.transfer({
        fromPubkey: senderKeypair.publicKey,
        toPubkey: senderKeypair.publicKey, // Dummy transfer to self
        lamports: 1
      })
    ).compileMessage();
    const { value } = await this.connection.getFeeForMessage(message);
    return value;
  }
}

module.exports = Send;