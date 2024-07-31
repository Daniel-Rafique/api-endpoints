require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');
const cron = require('node-cron');
const WalletProcessor = require('../WalletProcessor'); 
const DataManager = require('../database');
const tokenProgramId = process.env.TOKEN_PROGRAM_ID;
const interval = process.env.CRON_JOB_INTERVAL || "*/1 * * * *"; 
// const interval = "0 0 * * *";

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
      const confirmedSignatures = await connection.getConfirmedSignaturesForAddress2(publicKey, { limit: 1 });
      const confirmedTransaction = await connection.getConfirmedTransaction(confirmedSignatures[0].signature);
      return confirmedTransaction;
    } catch (error) {
      console.error('Error fetching transaction history:', error);
      throw error;
    }
  }

  async returnSolToWalletB(walletBPublicKeyString, amount) {
    try {
      const walletBPublicKey = new PublicKey(walletBPublicKeyString);
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.walletAKeypair.publicKey,
          toPubkey: walletBPublicKey,
          lamports: amount * 1_000_000_000 // Convert SOL to lamports
        })
      );

      const connection = this.getNextConnection();
      const signature = await connection.sendTransaction(transaction, [this.walletAKeypair]);
      await connection.confirmTransaction(signature);

      return signature;
    } catch (error) {
      console.error('Error returning SOL to Wallet B:', error);
      throw error;
    }
  }

  async handleWalletADeposit(chatId, walletAPublicKey, minimumSol, tokenMintA, tokenMintB, minimumToken) {
    const solBalanceA = await this.checkSolBalance(walletAPublicKey);
    if (solBalanceA >= minimumSol && solBalanceA > this.previousBalance) {
      const transaction = await this.getTransactionHistory(walletAPublicKey);
      const walletBPublicKey = transaction.transaction.message.accountKeys.find(key => key !== walletAPublicKey && key !== this.walletAKeypair.publicKey.toBase58());

      if (!walletBPublicKey) {
        console.error('No valid depositor wallet found.');
        return;
      }

      const tokenBalanceA = await this.checkTokenBalance(walletBPublicKey, tokenMintA);
      const tokenBalanceB = await this.checkTokenBalance(walletBPublicKey, tokenMintB);
      const totalTokenBalance = tokenBalanceA + tokenBalanceB;

      let message = `🔍 *Balance Check Report* 🔍\n\n`;
      message += `💰 *SOL Balance of Wallet A:* ${solBalanceA.toFixed(9)} SOL\n`;
      const isSolValid = solBalanceA >= minimumSol;
      const isTokenValid = totalTokenBalance >= minimumToken;

      message += isSolValid ? `✅ Sufficient SOL balance! (Minimum required: ${minimumSol} SOL)\n\n` : `❌ Insufficient SOL balance. (Minimum required: ${minimumSol} SOL)\n\n`;
      message += `💸 *Token Balance of Wallet B:*\n`;
      message += `- Token A: ${tokenBalanceA} tokens\n`;
      message += `- Token B: ${tokenBalanceB} tokens\n`;
      message += `- Total: ${totalTokenBalance} tokens\n`;
      message += isTokenValid ? `✅ Sufficient token balance! (Minimum required: ${minimumToken} tokens)\n\n` : `❌ Insufficient token balance. (Minimum required: ${minimumToken} tokens)\n\n`;

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
        if (!isSolValid || !isTokenValid) {
          message += `⚠️ *Action Required:* Please ensure your balances meet the minimum requirements.\n`;
          await this.telegramNotifier.sendTelegramMessage(chatId, message);
          const returnAmount = Math.min(solBalanceA, minimumSol);
          const signature = await this.returnSolToWalletB(walletBPublicKey, returnAmount);
          console.log(`Returned ${returnAmount} SOL to Wallet B. Transaction signature: ${signature}`);
        }
      }

      this.previousBalance = solBalanceA;
    }
  }

  async startPeriodicCheck(chatId) {
    const userData = await this.dataManager.getCollection(chatId);
    const walletAPublicKey = userData.wallet;
    const minimumSol = userData.boostCost;
    const tokenMintA = userData.contractAddress;
    const tokenMintB = userData.contractAddress;
    const minimumToken = 500000;
    cron.schedule(interval, async () => {
      console.log('Running periodic balance check...');
      await this.handleWalletADeposit(chatId, walletAPublicKey, minimumSol, tokenMintA, tokenMintB, minimumToken);
    });
  }
}

module.exports = BalanceChecker;