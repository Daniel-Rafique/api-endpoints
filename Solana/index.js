require('dotenv').config();
const bs58 = require('bs58');
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const fs = require('fs').promises;
const path = require('path');

const KOYNLABS_WALLET = process.env.KOYNLABS_WALLET;

class Solana {
  constructor() {
    this.connection = new Connection(process.env.SOLANA_RPC_ENDPOINT_1, 'confirmed');
  }

  async airDropSolana(data) {
    try {
      // Read Wallet A's private key from environment variable
      const walletAPrivateKey = data.walletPk;
      if (!walletAPrivateKey) {
        throw new Error('Wallet A private key not found in environment variables');
      }

      const walletAKeypair = Keypair.fromSecretKey(bs58.decode(walletAPrivateKey));
      const walletABalance = await this.connection.getBalance(walletAKeypair.publicKey);

      // Read the newly created wallets from the JSON file
      const filePath = path.resolve(__dirname, './marketMaker/wallets.json');
      const fileContent = await fs.readFile(filePath, 'utf8');
      const newWallets = JSON.parse(fileContent);

      // Calculate 75% of Wallet A's balance
      const amountToDistribute = Math.floor(walletABalance * 1);
      const amountPerWallet = Math.floor(amountToDistribute / newWallets.length);

      // Calculate 25% for KOYNLABS_WALLET
      const amountForKoynlabs = Math.floor(walletABalance * 1);

      // Create and send transactions to newly created wallets
      for (const wallet of newWallets) {
        const transaction = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: walletAKeypair.publicKey,
            toPubkey: new PublicKey(wallet.publicKey),
            lamports: amountPerWallet
          })
        );

        await this.sendAndConfirmTransaction(transaction, walletAKeypair);
      }

      // Send 25% to KOYNLABS_WALLET
      const koynlabsTransaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: walletAKeypair.publicKey,
          toPubkey: new PublicKey(KOYNLABS_WALLET),
          lamports: amountForKoynlabs
        })
      );

      await this.sendAndConfirmTransaction(koynlabsTransaction, walletAKeypair);

      console.log('Airdrop completed successfully');
    } catch (error) {
      console.error('Error during airdrop:', error);
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