const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction, web3 } = require('@solana/web3.js');
const { AccountLayout, u64 } = require('@solana/spl-token');
const bs58 = require('bs58');
const TelegramNotifier = require('../Telegram');
const WalletProcessor = require('../WalletProcessor');
const DataManager = require('../database')
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
    this.walletProcessor = new WalletProcessor();
    this.chatId = chatId;
    this.contractAddress = contractAddress;
    this.dataManager = new DataManager(chatId);

    this.messageQueue = [];
    this.ws = null;
    this.pingInterval = null;
    this.reconnectInterval = null;
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
      this.listenForTransactions();
    } catch (error) {
      console.error('Failed to initialize BalanceChecker:', error);
      this.distributeSolana = false; // Default to false if there's an error
      this.listenForTransactions();
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

  listenForTransactions() {
    const userData = this.dataManager.getCollection(this.chatId);
    const publicKeyToMention = this.distributeSolana ? this.dummyPublicKey.toString() : this.receiverKeypair.publicKey.toString();
    console.log(publicKeyToMention)
    if (!this.listenerActive || userData.walletsCreated) {
      console.log('Transaction listener is inactive or wallets are already created.');
      return;
    }

    console.log('Websocket endpoint', WEBSOCKET_ENDPOINT)
    this.ws = new WebSocket(WEBSOCKET_ENDPOINT);

    this.ws.on('open', () => {
      console.log('WebSocket connection opened');
      this.sendMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{
          mentions: [publicKeyToMention]
        }],
      });

      // Set up a ping interval to keep the connection alive
      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 10000); // Adjust the interval as needed
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
      this.cleanUpWebSocket();
      this.reconnectWebSocket();
    });

    this.ws.on('close', () => {
      console.log('WebSocket connection closed');
      this.cleanUpWebSocket();
      this.reconnectWebSocket();
    });
  }
  cleanUpWebSocket() {
    clearInterval(this.pingInterval);
    this.pingInterval = null;
    this.ws = null;
  }

  reconnectWebSocket() {
    if (!this.reconnectInterval) {
      this.reconnectInterval = setTimeout(() => {
        console.log('Attempting to reconnect WebSocket...');
        this.listenForTransactions();
      }, 5000); // Using a delay before reconnecting, adjust as necessary
    }
  }

  sendMessage(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      console.log('Sending message:', message);
      this.ws.send(JSON.stringify(message));
    } else {
      console.log('WebSocket not open, queueing message:', message);
      this.messageQueue.push(message);
      this.waitForOpenConnection(() => {
        this.processMessageQueue();
      });
    }
  }


  waitForOpenConnection(callback) {
    const maxAttempts = 10;
    let attempts = 0;

    const interval = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        clearInterval(interval);
        callback();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(interval);
          console.error('Failed to open WebSocket connection.');
        }
      }
    }, 1000); // Check every second
  }

  processMessageQueue() {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      this.sendMessage(message);
    }
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
        return;
      }

      console.log('Retrieved transaction:', JSON.stringify(transaction, null, 2));

      const senderPublicKey = transaction.transaction.message.accountKeys.find(
        key => !key.equals(this.receiverKeypair.publicKey)
      );

      if (!senderPublicKey) {
        console.error('Sender public key not found in the transaction');
        return;
      }

      const receiverIndex = transaction.transaction.message.accountKeys.findIndex(
        key => key.equals(this.receiverKeypair.publicKey)
      );

      const amountReceived = transaction.meta.postBalances[receiverIndex] - transaction.meta.preBalances[receiverIndex];

      if (amountReceived <= 0) {
        console.error('Invalid transaction amount');
        return;
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
        }
        if (tokenBalance < this.minimumTokenBalance) {
          console.log(`Sending insufficient ${TOKEN} balance message.`);
          message += MESSAGES.INSUFFICIENT_TOKEN(this.minimumTokenBalance);
        }
        if (this.shouldSendMessage(this.chatId, message)) {
          await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
        }
      } else {
        let message = '';
        this.dataManager.saveSenderWallet(this.chatId, { senderWallet: senderPublicKeyString });
        message += `✅ Received ${amountReceived / 1_000_000_000} SOL from ${senderPublicKeyString} \ntoken balance is ${tokenBalance}\n Any dust will be returned to ${senderPublicKeyString}`
        if (this.shouldSendMessage(this.chatId, message)) {
          await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
        }

        const chatId = this.chatId;
        await this.walletProcessor.addJob({ chatId });
      }
    } catch (error) {
      console.error('Error handling transaction:', error);
    }
  }

  async checkTokenBalance(senderPublicKeyString, amountReceived) {
    
    console.log('Checking token balance for wallet:', senderPublicKeyString.toString(), 'with mint:', MINT_ADDRESS.toString());

    const tokenMintAddress = new PublicKey(MINT_ADDRESS);
    const accounts = await this.connection.getParsedTokenAccountsByOwner(senderPublicKeyString, { programId: TOKEN_PROGRAM_ID });
    const accountInfo = accounts.value.find((account) => account.account.data.parsed.info.mint === tokenMintAddress.toBase58());

    const tokenBalance = accountInfo ? new Decimal(accountInfo.account.data.parsed.info.tokenAmount.amount) : new Decimal(0);

    if (tokenBalance < this.minimumTokenBalance) {

      await this.returnSol(senderPublicKeyString, amountReceived);
      const message = MESSAGES.INSUFFICIENT_TOKEN(this.minimumSolBalance);

      if (this.shouldSendMessage(this.chatId, message)) {
        await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
      }
    }

    return tokenBalance;
  }


  async returnSol(senderPublicKeyString, amountReceived) {
    try {
      const estimatedFee = await this.getEstimatedFee();
      const amountToReturn = amountReceived - estimatedFee; // Double the estimated fee

      if (amountToReturn <= 0) {
        console.error('Amount to return is less than or equal to the transaction fee');
        return;
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

          if (this.shouldSendMessage(this.chatId, message)) {
            await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
          }

          return;
        } catch (error) {
          console.error('Error sending transaction, retrying...', error);
        }
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retrying
        currentBlockHeight = await this.connection.getBlockHeight();
      }

      console.error('Failed to return SOL: transaction expired');
    } catch (error) {
      console.error('Error returning SOL to sender:', error);
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