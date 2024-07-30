require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');
const cron = require('node-cron');
const TaskProcessor = require('./TaskProcessor'); // Adjust path as necessary

const taskProcessor = new TaskProcessor();

class BalanceChecker {
  constructor(rpcEndpoints, telegramToken, walletASecretKey) {
    this.rpcEndpoints = rpcEndpoints;
    this.currentEndpointIndex = 0;
    this.telegramToken = telegramToken;
    this.telegramApiUrl = `https://api.telegram.org/bot${telegramToken}`;
    this.walletAKeypair = Keypair.fromSecretKey(bs58.decode(walletASecretKey));
    this.previousBalance = 0;
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
        programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
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

  async sendTelegramMessage(chatId, text) {
    const url = `${this.telegramApiUrl}/sendMessage`;
    try {
      await axios.post(url, {
        chat_id: chatId,
        text: text,
      });
    } catch (error) {
      console.error('Error sending message:', error);
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

      if (totalTokenBalance >= minimumToken) {
        const responseMessage = `SOL and token balances are valid. Initializing wallet creation and instance setup.`;
        await this.sendTelegramMessage(chatId, responseMessage);
        taskProcessor.addJob({
          chatId,
          contractAddress: walletAPublicKey,
          boostType: "type",
          boostCost: minimumSol,
          wallet: walletBPublicKey,
          batchSize: 1000,
          makers: 1000,
          timestamp: Date.now()
        });
      } else {
        const responseMessage = `Wallet B's total token balance does not meet the required minimum of ${minimumToken} tokens. Returning SOL.`;
        await this.sendTelegramMessage(chatId, responseMessage);
        await this.returnSolToWalletB(walletBPublicKey, solBalanceA);
      }

      this.previousBalance = solBalanceA;
    }
  }

  startPeriodicCheck(chatId, walletAPublicKey, minimumSol, tokenMintA, tokenMintB, minimumToken, interval) {
    cron.schedule(interval, async () => {
      console.log('Running periodic balance check...');
      await this.handleWalletADeposit(chatId, walletAPublicKey, minimumSol, tokenMintA, tokenMintB, minimumToken);
    });
  }
}

// Test the balance checker
const rpcEndpoints = [
  process.env.SOLANA_RPC_ENDPOINT_1,
  process.env.SOLANA_RPC_ENDPOINT_2,
]; // Replace with your actual RPC endpoints
const telegramToken = process.env.TELEGRAM_TOKEN;
const chatId = '243733813'; // Replace with your Telegram chat ID
const walletAPublicKey = 'DogXeemGkG3hjeuF8LJmE2SmuCLDZvFnYga7PUZFj4uU'; // Replace with Wallet A public key
const walletASecretKey = '2CJWKMDdy62vop3knPNbgUX2CJvmBLGNyb3FWkaBS1PdsyFnCnz18qfE5BEgzCvz7h5fkkaKEhkQ2xrqmkaPCryr'; // Wallet A's secret key in base58 format
const minimumSol = 4; // Minimum SOL balance required in Wallet A
const minimumToken = 5000; // Minimum token balance required in Wallet B
const tokenMintA = '7CXCCZNBs5U72RPVtEVPjy5Gr9XcyqqVZoPvy446FMGP'; // Replace with the token mint A address
const tokenMintB = '4k3Dyjzvzp8eMLLhxjYhNGxdjLWi91Q1aj3h4F78A7RW'; // Replace with the token mint B address
const interval = '*/1 * * * *'; // Check every minute

const balanceChecker = new BalanceChecker(rpcEndpoints, telegramToken, walletASecretKey);
balanceChecker.startPeriodicCheck(chatId, walletAPublicKey, minimumSol, tokenMintA, tokenMintB, minimumToken, interval);