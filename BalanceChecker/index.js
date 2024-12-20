const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction, web3 } = require('@solana/web3.js');
const bs58 = require('bs58');
const DataManager = require('../database')
const DiscordNotifier = require('../Discord');
const TelegramNotifier = require('../Telegram');
const { formatTokenAmount } = require('../utils');
const InstanceManager = require('../InstanceManager');
const WebSocket = require('ws');

const redis = require('redis');
const client = redis.createClient();

client.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  await client.connect();
})();

const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT;
const SOLANA_RPC_ENDPOINT_2 = process.env.SOLANA_RPC_ENDPOINT_2;
const { MESSAGES } = require('../constants');

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const discordToken = process.env.DISCORD_BOT_TOKEN;

const TOKEN = process.env.TOKEN;

class BalanceChecker {
  constructor(chatId, receiverPrivateKey, minimumSolBalance, minimumTokenBalance, mintAddress, platform) {
    this.chatId = chatId;
    this.receiverKeypairString = receiverPrivateKey;
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    this.connection2 = new Connection(SOLANA_RPC_ENDPOINT_2, 'confirmed');
    this.receiverKeypair = Keypair.fromSecretKey(bs58.decode(this.receiverKeypairString));
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
  }

  // New method to connect to Bitquery
  async connectToBitquery() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      const token = BALANCE_BITQUERY_TOKEN; // Ensure this constant is defined


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
        resolve(true);
        this.bitqueryConnection.send(initMessage);
      });

      this.bitqueryConnection.on("message", (data) => {
        const response = JSON.parse(data);
        if (response.type === "connection_ack") {
          console.log("Connection acknowledged by Bitquery.");
          clearTimeout(connectionTimeout);
          this.emit('connected');
          resolve(true);
        }
        if (response.type === "data") {
          this.emit('balanceUpdate', response.payload.data);
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
        if (!this.isConnected) {
          await this.connectToBitquery();
        }
        // TODO check that we can retrive send token balance
        return await new Promise((resolve, reject) => {
          const query = `
subscription{
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
      }
    }
  }
}
          `;

          const subscriptionMessage = JSON.stringify({
            type: "start",
            id: "1",
            payload: { query },
          });

          const queryTimeout = setTimeout(() => {
            cleanup();
            reject(new Error('Query timeout'));
          }, 120000);

          const cleanup = () => {
            this.removeListener('balanceUpdate', onBalanceUpdate);
            this.removeListener('error', onError);
            clearTimeout(queryTimeout);
          };

          const onBalanceUpdate = (data) => {
            console.log("Received balance update data:", data); // Debugging line

            // Check if the data contains BalanceUpdate
            if (data?.Solana?.BalanceUpdates) {
              const balanceUpdate = data.Solana.BalanceUpdates[0]; // Access the first item if it's an array
              const senderWallet = data.Solana.Transaction.Signer;
              // Check if balanceUpdate is an object
              if (balanceUpdate && balanceUpdate.BalanceUpdate) {
                const update = balanceUpdate.BalanceUpdate;

                const solBalance = update.Currency.MintAddress === "11111111111111111111111111111111" ? {
                  balance: this.formatBalance(update.PostBalance),
                  symbol: update.Currency.Symbol,
                  name: update.Currency.Name
                } : { balance: "0", symbol: "SOL", name: "Solana" };

                const tokenBalance = update.Currency.MintAddress === String(tokenMint) ? {
                  balance: this.formatBalance(update.Amount),
                  symbol: update.Currency.Symbol,
                  name: update.Currency.Name
                } : { balance: "0", symbol: null, name: null };

                const balances = {
                  SOL: solBalance,
                  token: tokenBalance,
                  sender: senderWallet
                };

                this.handleTransaction(balances, interaction)
                cleanup();
                resolve(balances);
              } else {
                console.error("BalanceUpdate is not found in the response:", data);
                cleanup();
                reject(new Error('BalanceUpdate is not found'));
              }
            } else {
              console.error("No BalanceUpdates found in the response:", data);
              cleanup();
              reject(new Error('No BalanceUpdates found'));
            }
          };

          if (this.bitqueryConnection.readyState === WebSocket.OPEN) {
            this.bitqueryConnection.send(subscriptionMessage);
          } else {
            cleanup();
            reject(new Error('WebSocket not open'));
          }
        });

      } catch (error) {
        console.error(`Balance fetch attempt ${retryCount + 1} failed:`, error);
        this.cleanup();
        retryCount++;

        if (retryCount < this.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        } else {
          throw new Error(`Failed to fetch balance after ${this.maxRetries} attempts`);
        }
      }
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

  async handleTransaction(balances, interaction) {
    try {
      console.log('Handling transaction:', balances);

      const senderPublicKeyString = new PublicKey(senderPublicKey);

      const tokenBalance = balances.token;
      const solBalance = balances.SOL
      const amountReceived = balances.SOL

      console.log('Token balance:', tokenBalance);
      console.log('Minimum token balance:', this.minimumTokenBalance);
      console.log('Sol balance:', solBalance);
      console.log('Minimum Sol balance:', this.minimumSolBalance);

      if (solBalance < this.minimumSolBalance || tokenBalance < this.minimumTokenBalance) {
        console.log('Returning SOL to sender.');
        await this.returnSol(senderPublicKeyString, amountReceived, interaction);
        let message = '';

        if (solBalance < this.minimumSolBalance) {
          console.log('Sending insufficient SOL balance message.');
          message += MESSAGES.INSUFFICIENT_SOL(this.minimumSolBalance);
        }

        if (tokenBalance < this.minimumTokenBalance) {
          console.log(`Sending insufficient ${TOKEN} balance message.`);
          message += MESSAGES.INSUFFICIENT_TOKEN(this.minimumTokenBalance);
        }

        if (message) {
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
      } else {
        let message = '';
        this.dataManager.saveSenderWallet(this.chatId, senderPublicKeyString.toString());
        const chatId = this.chatId;
        this.instanceManager.initializeMarketMakerInstance(chatId);
        const currentTokenBalance = tokenBalance / 1_000_000_000;
        const currentSolBalance = amountReceived / 1_000_000_000;
        const TOKEN_BALANCE = formatTokenAmount(currentTokenBalance);

        message += `✅ Received ${currentSolBalance} SOL from ${senderPublicKeyString} \ntoken balance is ${TOKEN_BALANCE}\n Any dust will be returned to ${senderPublicKeyString}`

        if (this.platform === 'telegram') {
          if (this.shouldSendMessage(this.chatId, message)) {
            await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
          }
        } else if (this.platform === 'discord') {
          if (userData?.applicationId && userData?.interactionToken) {
            await this.discordNotifier.sendDiscordMessage(interaction, message);
          }
        }
      }
    } catch (error) {
      console.error('Error handling transaction:', error);
      const errorMessage = `❌ Error handling transaction: ${error.message}`;

      if (this.platform === 'telegram') {
        await this.telegramNotifier.sendTelegramMessage(this.chatId, errorMessage);
      } else if (this.platform === 'discord') {
        const userData = await this.dataManager.getCollection(this.chatId);
        if (userData?.applicationId && userData?.interactionToken) {
          await this.discordNotifier.sendDiscordMessage(interaction, errorMessage);
        }
      }
    }
  }

  async returnSol(senderPublicKeyString, amountReceived, interaction) {
    try {
      const estimatedFee = await this.getEstimatedFee();
      const amountToReturn = amountReceived - estimatedFee;

      if (amountToReturn <= 0) {
        console.error('Amount to return is less than or equal to the transaction fee');
        return this.reconnectWebSocket();
      }

      let transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.receiverKeypair.publicKey,
          toPubkey: senderPublicKeyString,
          lamports: amountToReturn
        })
      );

      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = this.receiverKeypair.publicKey;
      transaction.sign(this.receiverKeypair);

      let currentBlockHeight = await this.connection.getBlockHeight();

      while (currentBlockHeight < lastValidBlockHeight) {
        try {
          const signature = await sendAndConfirmTransaction(this.connection, transaction, [this.receiverKeypair]);

          console.log(`Returned ${amountToReturn / 1_000_000_000} SOL to sender: ${senderPublicKeyString}`);
          const message = `✅ Returned ${amountToReturn / 1_000_000_000} SOL to sender: ${senderPublicKeyString}. \nTX signature: ${signature}`;

          if (this.platform === 'telegram') {
            if (this.shouldSendMessage(this.chatId, message) && signature) {
              await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
            }
          } else if (this.platform === 'discord') {
            const userData = await this.dataManager.getCollection(this.chatId);
            if (userData?.applicationId && userData?.interactionToken && signature) {
              await this.discordNotifier.sendDiscordMessage(interaction, message);
            }
          }

          return this.reconnectWebSocket();

        } catch (error) {
          if (error.name === 'SendTransactionError') {
            console.error('Transaction simulation failed:', error.message);
            console.error('Transaction logs:', error.transactionLogs || 'No logs available');

            // Fetch logs directly from the connection if available
            const confirmation = await connection.confirmTransaction({
              signature,
              blockhash: tx.message.recentBlockhash,
              lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight
            }, 'confirmed');

            // Get transaction info regardless of success/failure
            const txInfo = await connection.getTransaction(signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed'
            });

            // Log fees even if transaction failed
            const fee = txInfo?.meta?.fee || 0;
            console.log('Transaction fee:', {
              fee: fee / 1e9, // Convert lamports to SOL
              signature
            });

            if (confirmation.value.err || txInfo?.meta?.err) {
              const error = confirmation.value.err || txInfo?.meta?.err;
              console.log('Transaction failed:', {
                error,
                fee: fee / 1e9,
                signature,
                logs: txInfo?.meta?.logMessages
              });
              throw new Error(`Transaction failed, try increasing slippage`);
            }

            console.log('Transaction successful:', {
              signature,
              slot: txInfo?.slot,
              confirmationStatus: txInfo?.confirmationStatus,
              fee: fee / 1e9
            });

            // Decide whether to retry based on the specific error or logs
            if (this.shouldRetryTransaction(error)) {
              console.log('Retrying transaction...');
              continue;
            } else {
              console.log('Not retrying transaction due to specific error condition.');
              break;
            }
          } else {
            console.error('Unexpected error during transaction:', error);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retrying
        currentBlockHeight = await this.connection.getBlockHeight();
      }
      console.error('Failed to return SOL: transaction expired');
    } catch (error) {
      console.error('Error returning SOL to sender:', error);
      const errorMessage = `❌ Error returning SOL: ${error.message}`;

      if (this.platform === 'telegram') {
        await this.telegramNotifier.sendTelegramMessage(this.chatId, errorMessage);
      } else if (this.platform === 'discord') {
        const userData = await this.dataManager.getCollection(this.chatId);
        if (userData?.applicationId && userData?.interactionToken) {
          await this.discordNotifier.sendDiscordMessage(interaction, errorMessage);
        }
      }
    }
  }

  shouldRetryTransaction(error) {
    // Implement logic to determine whether a transaction should be retried based on the error or logs
    // For example, you may choose to retry on network-related issues, but not on issues like "account not found"
    if (error.message.includes('Attempt to debit an account but found no record of a prior credit')) {
      return false; // Don't retry if the account lacks sufficient funds
    }
    // Add other conditions as necessary
    return true; // Default to retrying in other cases
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

  async getEstimatedFee() {
    const { blockhash } = await this.connection.getLatestBlockhash();
    const message = new Transaction({
      recentBlockhash: blockhash,
      feePayer: this.receiverKeypair.publicKey
    }).add(
      SystemProgram.transfer({
        fromPubkey: this.receiverKeypair.publicKey,
        toPubkey: this.receiverKeypair.publicKey, // Dummy transfer to self
        lamports: 1
      })
    ).compileMessage();
    const { value } = await this.connection.getFeeForMessage(message);
    return value;
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
}

module.exports = BalanceChecker;