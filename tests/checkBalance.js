require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');
const cron = require('node-cron');

class BalanceChecker {
  constructor(rpcEndpoint, telegramToken, walletASecretKey) {
    this.connection = new Connection(rpcEndpoint, 'confirmed');
    this.telegramToken = telegramToken;
    this.telegramApiUrl = `https://api.telegram.org/bot${telegramToken}`;
    this.walletAKeypair = Keypair.fromSecretKey(bs58.decode(walletASecretKey));
  }

  async checkSolBalance(publicKeyString) {
    try {
      const publicKey = new PublicKey(publicKeyString);
      const balance = await this.connection.getBalance(publicKey);
      const solBalance = balance / 1_000_000_000; // Convert lamports to SOL

      return solBalance;
    } catch (error) {
      console.error('Error checking SOL balance:', error);
      throw error;
    }
  }

  async checkTokenBalance(publicKeyString, tokenMint) {
    try {
      const publicKey = new PublicKey(publicKeyString);
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(publicKey, {
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
      
      const signature = await this.connection.sendTransaction(transaction, [this.walletAKeypair]);
      await this.connection.confirmTransaction(signature);

      return signature;
    } catch (error) {
      console.error('Error returning SOL to Wallet B:', error);
      throw error;
    }
  }

  async runTest(chatId, walletAPublicKey, walletBPublicKey, minimumSol, minimumToken, tokenMintA, tokenMintB) {
    try {
      // Check SOL balance of Wallet A
      const solBalanceA = await this.checkSolBalance(walletAPublicKey);
      let message = `SOL Balance of Wallet A: ${solBalanceA.toFixed(9)} SOL\n`;
      const isSolValid = solBalanceA >= minimumSol;

      // Check Token balances of Wallet B
      const tokenBalanceA = await this.checkTokenBalance(walletBPublicKey, tokenMintA);
      const tokenBalanceB = await this.checkTokenBalance(walletBPublicKey, tokenMintB);
      const totalTokenBalance = tokenBalanceA + tokenBalanceB;

      message += `Token Balance of Wallet B (Token A): ${tokenBalanceA} tokens\n`;
      message += `Token Balance of Wallet B (Token B): ${tokenBalanceB} tokens\n`;
      message += `Total Token Balance of Wallet B: ${totalTokenBalance} tokens\n`;

      const isTokenValid = totalTokenBalance >= minimumToken;

      if (isSolValid && isTokenValid) {
        message += `Both SOL balance in Wallet A and Token balance in Wallet B are sufficient.\n`;
      } else {
        if (!isSolValid) {
          message += `Wallet A's SOL balance does not meet the required minimum of ${minimumSol} SOL.\n`;
        }
        if (!isTokenValid) {
          message += `Wallet B's total token balance does not meet the required minimum of ${minimumToken} tokens.\n`;
        }
        if (!isSolValid || !isTokenValid) {
          const returnAmount = Math.min(solBalanceA, minimumSol);
          const signature = await this.returnSolToWalletB(walletBPublicKey, returnAmount);
          message += `Returned ${returnAmount} SOL to Wallet B. Transaction signature: ${signature}\n`;
        }
      }

      await this.sendTelegramMessage(chatId, message);
    } catch (error) {
      console.error('Error during balance check:', error);
      await this.sendTelegramMessage(chatId, `Error during balance check: ${error.message}`);
    }
  }

  startPeriodicCheck(chatId, walletAPublicKey, walletBPublicKey, minimumSol, minimumToken, tokenMintA, tokenMintB, interval) {
    cron.schedule(interval, async () => {
      console.log('Running periodic balance check...');
      await this.runTest(chatId, walletAPublicKey, walletBPublicKey, minimumSol, minimumToken, tokenMintA, tokenMintB);
    });
  }
}

// Test the balance checker
const rpcEndpoint = process.env.SOLANA_RPC_ENDPOINT;
const telegramToken = process.env.TELEGRAM_TOKEN;
const chatId = '243733813'; // Replace with your Telegram chat ID
const walletAPublicKey = 'DogXeemGkG3hjeuF8LJmE2SmuCLDZvFnYga7PUZFj4uU'; // Replace with Wallet A public key
const walletASecretKey = '2CJWKMDdy62vop3knPNbgUX2CJvmBLGNyb3FWkaBS1PdsyFnCnz18qfE5BEgzCvz7h5fkkaKEhkQ2xrqmkaPCryr'; // Wallet A's secret key in base58 format
const walletBPublicKey = 'Fk3zbR5RkN9T3mZ3tGeZZT3oPC5BRASZeJWBK8St96yv'; // Replace with Wallet B public key
const minimumSol = 4; // Minimum SOL balance required in Wallet A
const minimumToken = 5000; // Minimum token balance required in Wallet B
const tokenMintA = '7CXCCZNBs5U72RPVtEVPjy5Gr9XcyqqVZoPvy446FMGP'; // Replace with the token mint A address
const tokenMintB = '4k3Dyjzvzp8eMLLhxjYhNGxdjLWi91Q1aj3h4F78A7RW'; // Replace with the token mint B address
const interval = '*/10 * * * *'; // Check every 10 minutes

const balanceChecker = new BalanceChecker(rpcEndpoint, telegramToken, walletASecretKey);
balanceChecker.startPeriodicCheck(chatId, walletAPublicKey, walletBPublicKey, minimumSol, minimumToken, tokenMintA, tokenMintB, interval);