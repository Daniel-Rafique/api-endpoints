require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const cron = require('node-cron');
const WalletProcessor = require('../WalletProcessor');
const DataManager = require('../database');
const tokenProgramId = process.env.TOKEN_PROGRAM_ID || 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const interval = process.env.CRON_JOB_INTERVAL || "*/1 * * * *"; 
// const interval = "0 0 * * *"; // Uncomment for daily check

class BalanceChecker {
  constructor(rpcEndpoints, telegramNotifier, walletASecretKey) {
    this.rpcEndpoints = rpcEndpoints;
    this.currentEndpointIndex = 0;
    this.telegramNotifier = telegramNotifier;
    this.walletAKeypair = Keypair.fromSecretKey(bs58.decode(walletASecretKey));
    this.previousBalance = 0;
    this.walletProcessor = new WalletProcessor();
    this.dataManager = new DataManager();
  }
  
  getNextConnection() {
    this.currentEndpointIndex = (this.currentEndpointIndex + 1) % this.rpcEndpoints.length;
    const connection = new Connection(this.rpcEndpoints[this.currentEndpointIndex], 'confirmed');
    console.log(`Using RPC endpoint: ${this.rpcEndpoints[this.currentEndpointIndex]}`);
    return connection;
  }

  async checkSolBalance(publicKeyString) {
    try {
      const connection = this.getNextConnection();
      const publicKey = new PublicKey(publicKeyString);
      const balance = await connection.getBalance(publicKey);
      const solBalance = balance / 1_000_000_000; // Convert lamports to SOL
      return solBalance;
    } catch (error) {
      console.error('Error checking SOL balance:', error);
      throw error;
    }
  }

  async checkTokenBalance(publicKeyString, tokenMint) {
    try {
      const connection = this.getNextConnection();
      const publicKey = new PublicKey(publicKeyString);
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
        programId: new PublicKey(tokenProgramId)
      });

      const tokenAccount = tokenAccounts.value.find(
        account => account.account.data.parsed.info.mint === tokenMint
      );

      if (tokenAccount) {
        return tokenAccount.account.data.parsed.info.tokenAmount.uiAmount;
      }
      return 0;
    } catch (error) {
      console.error('Error checking token balance:', error);
      throw error;
    }
  }

  async getTransactionHistory(publicKeyString) {
    try {
      const connection = this.getNextConnection();
      const publicKey = new PublicKey(publicKeyString);
      const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 1 });
      const confirmedTransaction = await connection.getTransaction(signatures[0].signature);
      console.log('Confirmed transaction:', confirmedTransaction);
      return confirmedTransaction;
    } catch (error) {
      console.error('Error fetching transaction history:', error);
      throw error;
    }
  }

  async returnSolToWalletA(walletAPublicKeyString, amount) {
    try {
      const walletAPublicKey = new PublicKey(walletAPublicKeyString);
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.walletAKeypair.publicKey,
          toPubkey: walletAPublicKey,
          lamports: amount * 1_000_000_000 // Convert SOL to lamports
        })
      );

      const connection = this.getNextConnection();
      const signature = await connection.sendTransaction(transaction, [this.walletAKeypair]);
      await connection.confirmTransaction(signature);

      console.log('Transaction signature:', signature);

      return signature;
    } catch (error) {
      console.error('Error returning SOL to Wallet A:', error);
      throw error;
    }
  }

  async handleWalletADeposit(chatId, walletAPublicKey, minimumSol, tokenMint) {
    console.log('Checking wallet balances...: ', chatId, walletAPublicKey, minimumSol, tokenMint);
    const solBalanceB = await this.checkSolBalance(walletAPublicKey);
    if (solBalanceB >= minimumSol && solBalanceB > this.previousBalance) {
      const transaction = await this.getTransactionHistory(walletAPublicKey);
      const walletBPublicKey = transaction.transaction.message.accountKeys.find(key => key !== walletAPublicKey && key !== this.walletAKeypair.publicKey.toBase58());

      if (!walletBPublicKey) {
        console.error('No valid depositor wallet found.');
        return;
      }

      const solBalanceA = await this.checkSolBalance(walletBPublicKey);
      const tokenBalanceA = await this.checkTokenBalance(walletAPublicKey, tokenMint);

      console.log('Sol balance in Wallet B:', solBalanceB);
      console.log('Token balance in Wallet A:', tokenBalanceA);

      let message = `🔍 *Balance Check Report* 🔍\n\n`;
      message += `💰 *SOL Balance of Wallet B:* ${solBalanceB.toFixed(9)} SOL\n`;
      const isSolValid = solBalanceB >= minimumSol;
      const isTokenValid = tokenBalanceA >= 5000;

      console.log('Is SOL balance valid:', isSolValid);

      message += isSolValid ? `✅ Sufficient SOL balance! (Minimum required: ${minimumSol} SOL)\n\n` : `❌ Insufficient SOL balance. (Minimum required: ${minimumSol} SOL)\n\n`;
      message += `💸 *Token Balance of Wallet A:*\n`;
      message += `- Token: ${tokenBalanceA} tokens\n`;
      message += isTokenValid ? `✅ Sufficient token balance! (Minimum required: 5000 tokens)\n\n` : `❌ Insufficient token balance. (Minimum required: 5000 tokens)\n\n`;

      if (isSolValid && isTokenValid) {
        const userData = await this.dataManager.getCollection(chatId);

        message += `🎉 *Both balances are sufficient! Proceeding with the next steps.* 🚀\n`;
        await this.telegramNotifier.sendTelegramMessage(chatId, message);
        
        this.walletProcessor.addJob({
          chatId,
          contractAddress: userData.contractAddress,
          boostType: userData.boostType,
          boostCost: userData.boostCost,
          wallet: userData.wallet,
          batchSize: userData.batchSize,
          makers: userData.makers,
          timestamp: Date.now()
        });
      } else {
        message += `⚠️ *Action Required:* Please ensure your balances meet the minimum requirements.\n`;
        await this.telegramNotifier.sendTelegramMessage(chatId, message);
        const returnAmount = Math.min(solBalanceB, minimumSol);
        const signature = await this.returnSolToWalletA(walletBPublicKey, returnAmount);
        console.log(`Returned ${returnAmount} SOL to Wallet A. Transaction signature: ${signature}`);
      }

      this.previousBalance = solBalanceB;
    }
  }

  startPeriodicCheck(chatId, userData) {
    const walletAPublicKey = userData.wallet;
    const minimumSol = userData.boostCost; // Assuming Wallet A sends 1 SOL to Wallet B
    const tokenMint = userData.contractAddress;
    console.log(tokenMint, minimumSol, walletAPublicKey);
    cron.schedule(interval, async () => {
      console.log('Running periodic balance check...');
      await this.handleWalletADeposit(chatId, walletAPublicKey, minimumSol, tokenMint);
    });
  }
}

module.exports = BalanceChecker;