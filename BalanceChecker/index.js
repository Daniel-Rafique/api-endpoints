const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction, web3 } = require('@solana/web3.js');
const { AccountLayout, u64 } = require('@solana/spl-token');
const bs58 = require('bs58');
const DataManager = require('../database')
const TelegramNotifier = require('../Telegram');
const { formatTokenAmount } = require('../utils');
const InstanceInitializer = require('../InstanceInitializer');
const WebSocket = require('ws');

const redis = require('redis');
const client = redis.createClient();

client.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
  await client.connect();
})();

const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT; // Only one WebSocket endpoint is used now
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT;
const PROGRAM_ID = process.env.PROGRAM_ID;
const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS;
const TOKEN_PROGRAM_ID = new PublicKey(PROGRAM_ID);
const MINT_ADDRESS = new PublicKey(TOKEN_MINT_ADDRESS);
const { MESSAGES } = require('../constants');

const telegramToken = process.env.TELEGRAM_TOKEN;
const TOKEN = process.env.TOKEN;

class BalanceChecker {
  constructor(chatId, receiverPrivateKey, minimumSolBalance, minimumTokenBalance, contractAddress) {
    this.receiverKeypairString = receiverPrivateKey.toString();
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    this.receiverKeypair = Keypair.fromSecretKey(bs58.decode(this.receiverKeypairString));
    this.minimumSolBalance = minimumSolBalance;
    this.minimumTokenBalance = minimumTokenBalance;
    this.telegramNotifier = new TelegramNotifier(telegramToken);
    this.instanceInitializer = new InstanceInitializer();
    this.chatId = chatId;
    this.contractAddress = contractAddress;
    this.dataManager = new DataManager(chatId);
    this.messageQueue = [];
    this.ws = null;
    this.pingInterval = null;
    this.reconnectInterval = null;
    this.reconnectTimeout = null;
    this.listenerActive = true; // Flag to control the listener
    this.messageCache = {};
    this.initialize();
    this.dummyPublicKey = '2E5btHk6WtUASSiEzfBxRFEQUvNV8aX2FV4Zv3TyXn8M';
    this.distributeSolana = this.getDistributeSolanaFlag(chatId);
  }

  async initialize() {
    try {
      const userData = await this.dataManager.getCollection(this.chatId);
      this.distributeSolana = userData.distributeSolana ? true : false;
      this.connectWebSocket();
    } catch (error) {
      console.error('Failed to initialize BalanceChecker:', error);
      this.distributeSolana = false;
      this.connectWebSocket();
    }
  }

  async getDistributeSolanaFlag(chatId) {
    try {
      const userData = await this.dataManager.getCollection(chatId);
      return userData.distributeSolana ? true : false;
    } catch (error) {
      console.error('Failed to fetch distributeSolana flag from database:', error);
      return false; // Default to false if there's an error
    }
  }

  connectWebSocket() {
    console.log('Connecting to WebSocket endpoint:', WEBSOCKET_ENDPOINT);
    this.ws = new WebSocket(WEBSOCKET_ENDPOINT);

    this.ws.on('open', () => {
      console.log('WebSocket connection opened:', WEBSOCKET_ENDPOINT);
      this.subscribeToLogs();
      this.startPing();
    });

    this.ws.on('message', async (data) => {
      const response = JSON.parse(data);
      console.log('Received WebSocket message:', response);
      if (response.method === 'logsNotification') {
        const transactionSignature = response.params.result.value.signature;
        console.log(`New transaction: ${transactionSignature}`);
        if (transactionSignature) {
          await this.handleTransaction(transactionSignature);
        }
      }
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    this.ws.on('close', () => {
      console.log('WebSocket connection closed.');
      this.reconnectWebSocket();  // Reconnect automatically
      this.startPing()
    });
  }

  subscribeToLogs() {
    const publicKeyToMention = this.distributeSolana ? this.dummyPublicKey.toString() : this.receiverKeypair.publicKey.toString();
    const message = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{
        mentions: [publicKeyToMention]
      }]
    };
    this.ws.send(JSON.stringify(message));
    console.log('Subscribed to logs for wallet:', publicKeyToMention);
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      console.log('Subscribed to logs for wallet:', publicKeyToMention);
    } else {
      console.error('WebSocket is not open. Cannot subscribe to logs.');
    }
  }

  startPing() {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        console.log('Sending ping to WebSocket server.');
        this.ws.ping();  // Ping to keep the connection alive
      }
    }, 1000); // Ping every 1 second
  }

  reconnectWebSocket() {
    setTimeout(() => {
      this.connectWebSocket();
    }, 10000); // Reconnect after 1 second
  }


  async handleTransaction(signature) {
    try {
      const userData = this.dataManager;
      console.log('Handling transaction:', signature);

      const transaction = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!transaction) {
        console.error('Failed to retrieve transaction');
        return this.connectWebSocket();
      }

      console.log('Retrieved transaction:', JSON.stringify(transaction, null, 2));

      const senderPublicKey = transaction.transaction.message.accountKeys.find(
        key => !key.equals(this.receiverKeypair.publicKey)
      );

      if (!senderPublicKey) {
        console.error('Sender public key not found in the transaction');
        return this.connectWebSocket();
      }

      const receiverIndex = transaction.transaction.message.accountKeys.findIndex(
        key => key.equals(this.receiverKeypair.publicKey)
      );

      const amountReceived = transaction.meta.postBalances[receiverIndex] - transaction.meta.preBalances[receiverIndex];

      if (amountReceived <= 0) {
        console.error('Invalid transaction amount');
        return this.connectWebSocket();
      }

      const senderPublicKeyString = new PublicKey(senderPublicKey);

      const tokenBalance = await this.checkTokenBalance(senderPublicKeyString.toString(), amountReceived);
      const solBalance = await this.connection.getBalance(this.receiverKeypair.publicKey);

      console.log('Token balance:', tokenBalance);
      console.log('Minimum token balance:', this.minimumTokenBalance);
      console.log('Sol balance:', solBalance);
      console.log('Minimum Sol balance:', this.minimumSolBalance * 1_000_000_000);

      if (solBalance < this.minimumSolBalance * 1_000_000_000 || tokenBalance < this.minimumTokenBalance) {
        console.log('Returning SOL to sender.');
        await this.returnSol(senderPublicKeyString, amountReceived);
        let message = '';

        if (solBalance < this.minimumSolBalance * 1_000_000_000) {
          console.log('Sending insufficient SOL balance message.');
          message += MESSAGES.INSUFFICIENT_SOL(this.minimumSolBalance);
          if (this.shouldSendMessage(this.chatId, message)) {
            await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
          }
        }

        if (tokenBalance < this.minimumTokenBalance) {
          console.log(`Sending insufficient ${TOKEN} balance message.`);
          message += MESSAGES.INSUFFICIENT_TOKEN(this.minimumTokenBalance);
          if (this.shouldSendMessage(this.chatId, message)) {
            await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
          }
        }

      } else {
        let message = '';
        this.dataManager.saveSenderWallet(this.chatId, senderPublicKeyString.toString());
        const chatId = this.chatId;
        if (!userData.instancesCreated) {
          console.log('Creating market maker instance...');
          // this.instanceInitializer.initializeMarketMakerInstance(chatId, userData);
        }
        const currentTokenBalance = tokenBalance / 1_000_000_000;
        const currentSolBalance = amountReceived / 1_000_000_000;
        const TOKEN_BALANCE = formatTokenAmount(currentTokenBalance);

        message += `✅ Received ${currentSolBalance} SOL from ${senderPublicKeyString} \ntoken balance is ${TOKEN_BALANCE}\n Any dust will be returned to ${senderPublicKeyString}`

        if (this.shouldSendMessage(this.chatId, message)) {
          await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
        }
        return this.connectWebSocket();
      }
    } catch (error) {
      console.error('Error handling transaction:', error);
    }
  }

  async checkTokenBalance(senderPublicKeyString, amountReceived) {

    console.log('Checking token balance for wallet:', senderPublicKeyString.toString(), 'with mint:', MINT_ADDRESS.toString());

    const tokenMintAddress = new PublicKey(MINT_ADDRESS);
    const senderPublicKey = new PublicKey(senderPublicKeyString); // Ensure senderPublicKey is a PublicKey object
    const accounts = await this.connection.getParsedTokenAccountsByOwner(senderPublicKey, { programId: TOKEN_PROGRAM_ID });
    const accountInfo = accounts.value.find((account) => account.account.data.parsed.info.mint === tokenMintAddress.toBase58());
    const tokenBalance = accountInfo ? parseFloat(accountInfo.account.data.parsed.info.tokenAmount.amount) : 0;

    if (tokenBalance < this.minimumTokenBalance) {
      console.log('Returning SOL to sender.');
      await this.returnSol(senderPublicKeyString, amountReceived);
    }
    return tokenBalance;
  }


  async returnSol(senderPublicKeyString, amountReceived) {
    try {
      const estimatedFee = await this.getEstimatedFee();
      const amountToReturn = amountReceived - estimatedFee;

      if (amountToReturn <= 0) {
        console.error('Amount to return is less than or equal to the transaction fee');
        return this.connectWebSocket();
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

          if (this.shouldSendMessage(this.chatId, message) && signature) {
            await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
          }

          return this.connectWebSocket();
        } catch (error) {
          if (error.name === 'SendTransactionError') {
            console.error('Transaction simulation failed:', error.message);
            console.error('Transaction logs:', error.transactionLogs || 'No logs available');

            // Fetch logs directly from the connection if available
            const recentLogs = await this.connection.getConfirmedTransaction(error.signature);
            console.error('Fetched transaction logs:', recentLogs ? recentLogs.meta.logMessages : 'No logs found');

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
}

module.exports = BalanceChecker;