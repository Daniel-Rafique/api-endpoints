const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction, web3 } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, createTransferInstruction, getOrCreateAssociatedTokenAccount, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');
const DataManager = require('../database')
const DiscordNotifier = require('../Discord');
const EventEmitter = require('events');
const TelegramNotifier = require('../Telegram');
const { formatTokenAmount } = require('../utils');
const { decrypt } = require('../utils/encryption');
const InstanceManager = require('../InstanceManager');
const WebSocket = require('ws');

const redis = require('redis');
const client = redis.createClient();

client.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  await client.connect();
})();

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const { MESSAGES, BALANCE_BITQUERY_TOKEN } = require('../constants');

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const discordToken = process.env.DISCORD_BOT_TOKEN;

// Define the Memo Program ID
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

class BalanceChecker extends EventEmitter {
  constructor(chatId, receiverPrivateKey, minimumSolBalance, minimumTokenBalance, mintAddress, platform, interaction, userData) {
    super();
    this.chatId = chatId;
    this.receiverKeypairString = receiverPrivateKey;
    this.rpcEndpoints = [
      process.env.SOLANA_RPC_ENDPOINT_1,
      process.env.SOLANA_RPC_ENDPOINT_2
    ];
    this.currentRpcIndex = 0;
    this.connection = new Connection(this.rpcEndpoints[this.currentRpcIndex], 'confirmed');
    this.minimumSolBalance = minimumSolBalance;
    this.minimumTokenBalance = minimumTokenBalance;
    this.discordNotifier = new DiscordNotifier(discordToken);
    this.telegramNotifier = new TelegramNotifier(telegramToken);
    this.instanceManager = new InstanceManager(chatId);
    this.mintAddress = mintAddress;
    this.dataManager = new DataManager(chatId);
    this.messageQueue = [];
    this.ws = null;
    this.pingInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectTimeout = null;
    this.listenerActive = true; // Flag to control the listener
    this.messageCache = {};
    this.platform = platform;
    this.maxRetries = 3;
    this.retryDelay = 2000; // 2 seconds
    this.isConnected = false;
    this.interaction = interaction;
    this.userData = userData;
    try {
      this.receiverKeypair = Keypair.fromSecretKey(bs58.decode(decrypt(this.receiverKeypairString, ENCRYPTION_KEY)));
    } catch (error) {
      this.cleanup();
      console.error('Error decrypting receiver keypair:', error);
      throw error;
    }
  }

  // New method to connect to Bitquery
  async connectToBitquery() {
    console.log('Attempting to connect to Bitquery...');
    console.log('Token available:', !!BALANCE_BITQUERY_TOKEN);

    if (!BALANCE_BITQUERY_TOKEN) {
      throw new Error('BALANCE_BITQUERY_TOKEN is not defined');
    }

    if (this.connectionPromise) {
      console.log('Existing connection promise found, returning...');
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      const token = BALANCE_BITQUERY_TOKEN; // Ensure this constant is defined

      console.log('Creating new WebSocket connection...');
      this.bitqueryConnection = new WebSocket(
        "wss://streaming.bitquery.io/eap?token=" + token,
        "graphql-ws",
        {
          headers: {
            "Content-Type": "application/json",
          }
        }
      );

      const connectionTimeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
        this.cleanup();
      }, 60000);

      this.bitqueryConnection.on("open", () => {
        console.log("Connected to Bitquery Balance WebSocket.");
        this.isConnected = true;
        const initMessage = JSON.stringify({ type: "connection_init", payload: {} });
        this.bitqueryConnection.send(initMessage);
        resolve(true);
      });

      this.bitqueryConnection.on("message", (data) => {
        console.log('Received message from Bitquery:', data.toString());
        const response = JSON.parse(data);
        if (response.type === "connection_ack") {
          console.log("Connection acknowledged by Bitquery.");
          clearTimeout(connectionTimeout);
          this.emit('connected');
          resolve(true);
        }
        if (response.type === "data" && this.userData.mode !== 'sniper') {
          console.log('Received data from Bitquery:', response.payload.data);
          this.emit('balanceUpdate', response.payload.data);

          // Extract transaction signature if available
          let transactionSignature = null;
          if (response.payload.data?.Solana?.BalanceUpdates?.[0]?.Transaction?.Hash) {
            transactionSignature = response.payload.data.Solana.BalanceUpdates[0].Transaction.Hash;
            console.log("Transaction signature:", transactionSignature);
          }

          this.handleTransaction(response.payload.data, transactionSignature);
        }
        if (response.type === "error") {
          console.error("Received error from Bitquery:", response.payload.errors[0].message);
          this.emit('error', new Error(response.payload.errors[0].message));
        }
      });

      this.bitqueryConnection.on("close", () => {
        console.log("Bitquery WebSocket connection closed.");
        this.cleanup();
        reject(new Error('WebSocket closed'));
      });

      this.bitqueryConnection.on("error", (error) => {
        console.error("Bitquery WebSocket error:", error);
        this.cleanup();
        reject(error);
      });
    });

    return this.connectionPromise;
  }

  // New method to get balance
  async getBalance(interaction) {
    let retryCount = 0;
    const walletAddress = this.receiverKeypair.publicKey;
    const tokenMint = this.mintAddress;

    console.log('Getting balance for:', walletAddress);
    console.log('Token mint:', tokenMint);

    while (retryCount < this.maxRetries) {
      try {
        // Check connection status and reconnect if needed
        this.isConnected = false; // Ensure initial state
        if (!this.isConnected) {
          console.log('Attempting to connect to Bitquery...');
          await this.connectToBitquery(interaction);
          console.log('Connected to Bitquery successfully');
        }

        return await new Promise((resolve, reject) => {
          const query = `
            subscription {
              Solana {
                BalanceUpdates(
                  limitBy: {by: BalanceUpdate_Currency_MintAddress}
                  where: {BalanceUpdate: {Account: {Owner: {is: "${walletAddress}"}}}}
                  orderBy: {descending: Block_Time}
                ) {
                  BalanceUpdate {
                    Currency {
                      Symbol
                      Name
                      MintAddress
                    }
                    Amount
                    AmountInUSD
                    PreBalance
                    PostBalance
                    PreBalanceInUSD
                    PostBalanceInUSD
                  }
                  Transaction {
                    Signer
                    Hash
                  }
                }
              }
            }
          `;

          const subscriptionMessage = JSON.stringify({
            type: "start",
            id: `balance_checker_${this.chatId}_${Date.now()}_${walletAddress}`,
            payload: { query },
          });

          // const queryTimeout = setTimeout(() => {
          //   cleanup();
          //   reject(new Error('Query timeout'));
          // }, 120000);

          const cleanup = () => {
            if (this.bitqueryConnection) {
              this.bitqueryConnection.removeListener('balanceUpdate', onBalanceUpdate);
              this.bitqueryConnection.removeListener('error', onError);
            }
            // clearTimeout(queryTimeout);
          };

          const onError = (error) => {
            console.error('Bitquery subscription error:', error);
            cleanup();
            this.bitqueryConnection.close();
            this.isConnected = false;
            reject(error);
          };

          const onBalanceUpdate = (data) => {
            console.log("Received balance update data:", data);
            // Clean up and close connection
            cleanup();
            if (this.bitqueryConnection) {
              this.bitqueryConnection.close();
              this.isConnected = false;
            }

            // Extract transaction signature if available
            let transactionSignature = null;
            if (data?.Solana?.BalanceUpdates?.[0]?.Transaction?.Hash) {
              transactionSignature = data.Solana.BalanceUpdates[0].Transaction.Hash;
              console.log("Transaction signature:", transactionSignature);
            }

            // Handle the transaction and resolve the promise
            this.handleTransaction(data, transactionSignature);
            resolve(data); // Resolve the promise to end the getBalance flow
          };

          // Add error listener
          this.bitqueryConnection.on('error', onError);

          // Add balance update listener
          this.bitqueryConnection.on('balanceUpdate', onBalanceUpdate);

          if (this.bitqueryConnection.readyState === WebSocket.OPEN) {
            console.log('Sending subscription message to Bitquery');
            this.bitqueryConnection.send(subscriptionMessage);
          } else {
            console.error('WebSocket not open. Current state:', this.bitqueryConnection.readyState);
            cleanup();
            reject(new Error('WebSocket not open'));
          }
        });

      } catch (error) {
        console.error(`Balance fetch attempt ${retryCount + 1}`);
        this.cleanup();
        retryCount++;

        if (retryCount < this.maxRetries) {
          console.log(`Waiting ${this.retryDelay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        } else {
          throw new Error(`Failed to fetch balance after ${this.maxRetries} attempts`);
        }
      }
    }
  }

  async getTokenBalance(mintAddress, wallet) {
    try {
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        new PublicKey(wallet),
        { mint: new PublicKey(mintAddress) }
      );

      if (!tokenAccounts.value.length) {
        return 0;
      }

      // Get the token account info
      const accountInfo = await this.connection.getTokenAccountBalance(
        tokenAccounts.value[0].pubkey
      );

      return accountInfo.value.uiAmount || 0;

    } catch (error) {
      console.error('Error getting token balance:', error);
      return 0;
    }
  }

  formatBalance(balance) {
    if (balance === null || balance === undefined) {
      return "0";
    }
    if (typeof balance === 'number') {
      return balance.toFixed(6);
    } else if (typeof balance === 'string') {
      return parseFloat(balance).toFixed(6);
    }
    return "0";
  }

  // Add a new method to fetch transaction details including memos
  async getTransactionDetails(signature) {
    try {
      console.log(`Fetching transaction details for signature: ${signature}`);

      // Try multiple RPC endpoints if one fails
      let transaction = null;
      let error = null;

      for (let i = 0; i < this.rpcEndpoints.length; i++) {
        try {
          const connection = new Connection(this.rpcEndpoints[i], 'confirmed');
          transaction = await connection.getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          });

          if (transaction) break;
        } catch (err) {
          console.error(`Error fetching transaction from endpoint ${i}:`, err);
          error = err;
        }
      }

      if (!transaction) {
        throw error || new Error('Failed to fetch transaction details');
      }

      // Extract memo from transaction if it exists
      let memo = null;

      if (transaction.meta && transaction.transaction.message.instructions) {
        for (const instruction of transaction.transaction.message.instructions) {
          // Check if this is a memo instruction
          const programId = transaction.transaction.message.accountKeys[instruction.programId].toString();

          if (programId === MEMO_PROGRAM_ID) {
            try {
              // Decode the memo data
              const data = Buffer.from(bs58.decode(instruction.data));
              memo = data.toString('utf8');
              console.log('Found memo in transaction:', memo);
              break;
            } catch (err) {
              console.error('Error decoding memo data:', err);
            }
          }
        }
      }

      return {
        transaction,
        memo
      };
    } catch (error) {
      console.error('Error getting transaction details:', error);
      return { transaction: null, memo: null };
    }
  }

  async handleTransaction(balances, transactionSignature = null) {
    const sendMessage = async (message) => {
      try {
        if (this.platform === 'telegram') {
          await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
        } else if (this.platform === 'discord' && this.interaction) {
          await this.discordNotifier.sendDiscordMessage(this.interaction, message);
        }
      } catch (error) {
        console.error('Error sending message:', error);
      }
    };

    try {
      // Validate and extract data from Bitquery response
      if (!balances?.Solana?.BalanceUpdates?.[0]?.BalanceUpdate) {
        throw new Error('Invalid balance data structure');
      }

      const balanceUpdate = balances.Solana.BalanceUpdates[0].BalanceUpdate;
      const transaction = balances.Solana.BalanceUpdates[0].Transaction;

      // Extract required values
      const tokenBalance = await this.getTokenBalance(this.mintAddress, transaction?.Signer);
      const solBalance = parseFloat(balanceUpdate.PostBalance) || 0;
      const amountReceived = parseFloat(balanceUpdate.Amount) || 0;
      const senderPublicKeyString = transaction?.Signer;

      console.log('Parsed transaction details:', {
        amountReceived,
        tokenBalance,
        solBalance,
        senderPublicKey: senderPublicKeyString,
        platform: this.platform,
        rawBalanceUpdate: balanceUpdate,
        rawTransaction: transaction
      });

      // Validate essential data
      if (!senderPublicKeyString) {
        throw new Error('Missing sender public key');
      }

      // Check for transaction memo if we have a signature
      if (transactionSignature) {
        const { memo } = await this.getTransactionDetails(transactionSignature);
        // Verify the memo contains expected text
        if (memo) {
          console.log('Transaction memo found:', memo);
          // If memo doesn't include "From Koynlabs Wallet", return SOL
          if (!memo.includes('From Koynlabs Wallet')) {
            console.log('Transaction failed:', memo);
            await sendMessage(`❌ Transaction failed: \n` +
              `1. The transaction must be from Koynlabs Wallet.\n` +
              `2. Type /start then try the transaction again.`);
            // Return the SOL since this doesn't appear to be from our wallet
            await this.returnSol(
              senderPublicKeyString,
              amountReceived,
              this.platform === 'discord' ? this.interaction : null
            );
            return;
          }
        }
      }

      // Check balances
      if (solBalance < this.minimumSolBalance) {
        console.log('Insufficient SOL balance, returning SOL.');
        await this.returnSol(
          senderPublicKeyString,
          amountReceived,
          this.platform === 'discord' ? this.interaction : null
        );

        let message = '';
        if (solBalance < this.minimumSolBalance) {
          message += MESSAGES.INSUFFICIENT_SOL(this.minimumSolBalance);
        }

        await sendMessage(message);
        return;
      }

      if (tokenBalance < this.minimumTokenBalance) {
        console.log('Insufficient token balance, returning SOL.');
        await this.returnSol(
          senderPublicKeyString,
          amountReceived,
          this.platform === 'discord' ? this.interaction : null
        );

        let message = '';
        if (tokenBalance < this.minimumTokenBalance) {
          message += MESSAGES.INSUFFICIENT_TOKEN(this.minimumTokenBalance);
        }

        await sendMessage(message);
        return;
      }

      // Process successful transaction
      await this.dataManager.saveSenderWallet(this.chatId, senderPublicKeyString);
      await this.instanceManager.initializeMarketMakerInstance(this.chatId);

      const TOKEN_BALANCE = formatTokenAmount(tokenBalance);

      const successMessage = `✅ Received ${amountReceived} SOL from ${senderPublicKeyString}\n` +
        `Token balance is ${TOKEN_BALANCE}\n`
      await sendMessage(successMessage);
      return;

    } catch (error) {
      console.error('Error handling transaction:', error);
      // await sendMessage(`❌ Error handling transaction: ${error.message}`);
    }
  }

  async returnSol(senderPublicKeyString, amountReceived, interaction = null) {
    try {
      // Create transaction to calculate fees first
      let transaction = new Transaction();
      const senderPubKey = new PublicKey(senderPublicKeyString);

      // Get fresh blockhash
      const response = await fetch('http://localhost:3000/api/wallet/solana');
      const data = await response.json();

      if (!data.success) {
        throw new Error('Failed to get blockhash');
      }

      transaction.recentBlockhash = data.blockhash.blockhash;
      transaction.feePayer = this.receiverKeypair.publicKey;

      // Add transfer instruction
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: this.receiverKeypair.publicKey,
          toPubkey: senderPubKey,
          lamports: Math.round(amountReceived * 1_000_000_000)
        })
      );

      // Calculate fee
      const message = transaction.compileMessage();
      const { value: fee } = await this.connection.getFeeForMessage(message);

      // Adjust transfer amount to account for fee
      const adjustedAmount = amountReceived - (fee / 1_000_000_000);

      if (adjustedAmount <= 0) {
        throw new Error('Amount too small to cover transaction fee');
      }

      // Create new transaction with adjusted amount
      transaction = new Transaction();
      transaction.recentBlockhash = data.blockhash.blockhash;
      transaction.feePayer = this.receiverKeypair.publicKey;

      transaction.add(
        SystemProgram.transfer({
          fromPubkey: this.receiverKeypair.publicKey,
          toPubkey: senderPubKey,
          lamports: Math.round(adjustedAmount * 1_000_000_000)
        })
      );

      // Sign and submit
      transaction.sign(this.receiverKeypair);
      const serializedTransaction = transaction.serialize();
      const encodedTx = bs58.encode(serializedTransaction);

      // Submit transaction through API
      const submitResponse = await fetch('http://localhost:3000/api/transaction/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: this.chatId,
          publicKey: this.receiverKeypair.publicKey.toString(),
          signedTransaction: encodedTx,
          type: 'send'
        })
      });

      const result = await submitResponse.json();
      if (!result.success) throw new Error(result.error || 'Transaction failed');

      // Send platform-specific success message
      const successMessage = `✅ Returned ${amountReceived} SOL to sender: ${senderPublicKeyString}\n` +
        `TX: https://solscan.io/tx/${result.signature}`;

      try {
        if (this.platform === 'telegram') {
          await this.telegramNotifier.sendTelegramMessage(this.chatId, successMessage);
          console.log('Transaction completed successfully');
          this.cleanup();
          this.isConnected = false;
          return;
        } else if (this.platform === 'discord' && interaction) {
          await this.discordNotifier.sendDiscordMessage(interaction, successMessage);
          console.log('Transaction completed successfully');
          this.cleanup();
          this.isConnected = false;
          return;
        }
      } catch (error) {
        console.error('Failed to send notification:', error);
        // Continue execution even if notification fails
        this.cleanup();
      }

      return {
        success: true,
        signature: result.signature,
        message: successMessage
      };

    } catch (error) {
      console.error('Send error:', error);
      const errorMessage = `❌ Error returning SOL: ${error.message}`;

      try {
        if (this.platform === 'telegram') {
          await this.telegramNotifier.sendTelegramMessage(this.chatId, errorMessage);
          this.cleanup();
        } else if (this.platform === 'discord' && interaction) {
          await this.discordNotifier.sendDiscordMessage(interaction, errorMessage);
          this.cleanup();
        }
      } catch (msgError) {
        console.error('Failed to send error notification:', msgError);
        this.cleanup();
      }
      throw error;
    }
  }

  async shouldSendMessage(chatId, message) {
    const cacheKey = String(chatId); // Ensure the cache key is a string
    const currentTime = Date.now();
    const cacheDuration = 600; // 10 minutes in seconds

    console.log(`Checking message cache for chatId: ${chatId}`);
    console.log(`Current message: ${message}`);

    try {
      const cachedMessage = await client.get(cacheKey);

      if (cachedMessage) {
        console.log(`Cached message found: ${cachedMessage}`);

        // Parse the cached message safely
        let parsedCache;
        try {
          parsedCache = JSON.parse(cachedMessage);
        } catch (error) {
          console.error('Error parsing cached message from Redis:', error);
          return false;
        }

        const { message: cachedMsg, timestamp } = parsedCache;

        if (message === cachedMsg && currentTime - timestamp < cacheDuration * 1000) {
          console.log('Duplicate message detected, not sending.');
          return false;
        }
      } else {
        console.log('No cached message found.');
      }
    } catch (error) {
      console.error('Error retrieving cached message from Redis:', error);
      return false;
    }

    console.log('No cached message found or cache expired, sending message.');
    try {
      await client.set(cacheKey, JSON.stringify({ message, timestamp: currentTime }), {
        EX: cacheDuration,
      });
    } catch (error) {
      console.error('Error setting cache in Redis:', error);
    }

    return true;
  }

  // Helper function to handle notifications for both platforms
  async sendNotification(message, interaction) {
    if (this.platform === 'telegram') {
      if (this.shouldSendMessage(this.chatId, message)) {
        await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
      }
    } else if (this.platform === 'discord') {
      const userData = await this.dataManager.getCollection(this.chatId);
      if (userData?.applicationId && userData?.interactionToken) {
        await this.discordNotifier.sendDiscordMessage(interaction, message);
      }
    }
  }

  // Add this method to listen for mode changes
  listenForModeChange(dataManager) {
    console.log('Setting up mode change listener in BalanceChecker');

    // Create a method to handle mode changes
    this.handleModeChange = async (chatId, newMode) => {
      console.log(`Mode change detected in BalanceChecker: ${chatId} -> ${newMode}`);

      // If mode changed to sniper, close Bitquery connections
      if (newMode === 'sniper' && this.chatId === chatId) {
        console.log('Sniper mode activated, closing Bitquery connections');
        this.cleanup();
        this.emit('modeChanged', { chatId, mode: newMode });
      }
    };

    // Register the event listener on the dataManager
    dataManager.on('modeChanged', this.handleModeChange);

    return () => {
      // Return a cleanup function to remove the listener when needed
      dataManager.removeListener('modeChanged', this.handleModeChange);
    };
  }

  // Enhance the cleanup method to be more thorough
  cleanup() {
    try {
      console.log('Cleaning up Bitquery connection...');

      // Close WebSocket connection if it exists
      if (this.bitqueryConnection) {
        if (this.bitqueryConnection.readyState === WebSocket.OPEN) {
          console.log('Closing open WebSocket connection');
          this.bitqueryConnection.close();
        }
        this.bitqueryConnection = null;
      }

      // Reset connection state
      this.isConnected = false;
      this.connectionPromise = null;

      // Remove all listeners
      if (this.removeAllListeners) {
        this.removeAllListeners('balanceUpdate');
        this.removeAllListeners('error');
        this.removeAllListeners('connected');
      }

      console.log('Cleanup completed');
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }
}

module.exports = BalanceChecker;