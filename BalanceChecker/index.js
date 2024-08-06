const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const TelegramNotifier = require('../Telegram');
const WalletProcessor = require('../WalletProcessor');
const WebSocket = require('ws');
const crypto = require('crypto');

const WEBSOCKET_ENDPOINTS = [process.env.SOLANA_WEBSOCKET_1, process.env.SOLANA_WEBSOCKET_2];
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_1;
const PROGRAM_ID = process.env.PROGRAM_ID;
const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS;
const TOKEN_PROGRAM_ID = new PublicKey(PROGRAM_ID);
const MINT_ADDRESS = new PublicKey(TOKEN_MINT_ADDRESS);
const { MESSAGES } = require('../constants');

const telegramToken = process.env.TELEGRAM_TOKEN;
const TOKEN = process.env.TOKEN;
let currentEndpointIndex = 0;

function getNextWebSocketEndpoint() {
  currentEndpointIndex = (currentEndpointIndex + 1) % WEBSOCKET_ENDPOINTS.length;
  return WEBSOCKET_ENDPOINTS[currentEndpointIndex];
}

function createCacheKey(chatId, text) {
  const hash = crypto.createHash('md5').update(text).digest('hex');
  return `${chatId}-${hash}`;
}

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

    this.messageQueue = [];
    this.messageCache = {};
    this.ws = null;
    this.pingInterval = null;
    this.reconnectInterval = null;
    this.listenForTransactions();
  }


  listenForTransactions() {
    const endpoint = getNextWebSocketEndpoint();
    this.ws = new WebSocket(endpoint);

    this.ws.on('open', () => {
      console.log('WebSocket connection opened');
      this.sendMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{
          mentions: [this.receiverKeypair.publicKey.toString()]
        }]
      });

      // Set up a ping interval to keep the connection alive
      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 5000); // Adjust the interval as needed
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
      if (error.message.includes('429')) {
        console.log('Received 429 error, switching WebSocket endpoint...');
        this.switchWebSocketEndpoint();
      }
    });

    this.ws.on('close', () => {
      console.log('WebSocket connection closed, reconnecting...');
      clearInterval(this.pingInterval);
      if (!this.reconnectInterval) {
        this.reconnectInterval = setInterval(() => {
          console.log('Attempting to reconnect WebSocket...');
          this.listenForTransactions();
        }, 1000); // Adjust the interval as needed
      }
    });
  }

  switchWebSocketEndpoint() {
    console.log('Switching WebSocket endpoint...');
    clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.close();
    }
    this.listenForTransactions();
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
  
      const tokenBalance = await this.checkTokenBalance(senderPublicKeyString, amountReceived);
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
        await this.sendTelegramMessage(this.chatId, message);
      } else {
        console.log(`Transaction is valid. Amount received: ${amountReceived / 1_000_000_000} SOL & ${TOKEN} Balance is ${tokenBalance}`);
        await this.sendTelegramMessage(
          this.chatId,
          `✅ Received ${amountReceived / 1_000_000_000} SOL from ${senderPublicKeyString} token balance is ${tokenBalance}`
        );
        const chatId = this.chatId;
        await this.walletProcessor.addJob({ chatId });
      }
    } catch (error) {
      console.error('Error handling transaction:', error);
    }
  }
  


  async checkTokenBalance(senderPublicKeyString, amountReceived) {
    console.log('Checking token balance for wallet:', senderPublicKeyString, 'with mint:', MINT_ADDRESS);

    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(senderPublicKeyString, {
      programId: TOKEN_PROGRAM_ID,
    });

    console.log('Fetched Token Accounts:', JSON.stringify(tokenAccounts, null, 2));

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    const tokenAccount = tokenAccounts.value.find(
      account => account.account.data.parsed.info
    );

    if (!tokenAccount.mint === this.contractAddress.toString()) {
      return 0;
    }

    console.log('Found token account:', JSON.stringify(tokenAccount, null, 2));
    const tokenBalance = parseFloat(tokenAccount.account.data.parsed.info.tokenAmount.uiAmount);

    if (tokenBalance < this.minimumTokenBalance) {
      await this.returnSol(senderPublicKeyString, amountReceived);
      const message = MESSAGES.INSUFFICIENT_TOKEN(this.minimumSolBalance);
      await this.sendTelegramMessage(this.chatId, message);
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
          await this.sendTelegramMessage(
            this.chatId,
            `✅ Returned ${amountToReturn / 1_000_000_000} SOL to sender: ${senderPublicKeyString}. \nTX signature: ${signature}`
          );
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

  async sendTelegramMessage(chatId, text) {
    const cacheKey = createCacheKey(chatId, text);
    const currentTime = Date.now();
  
    // Check if the same message was sent in the last 10 seconds
    if (this.messageCache[cacheKey] && (currentTime - this.messageCache[cacheKey].timestamp < 10000)) {
      console.log('Duplicate message detected, skipping send.');
    } else {
      await this.telegramNotifier.sendTelegramMessage(chatId, text);
      this.messageCache[cacheKey] = { timestamp: currentTime };
    }
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