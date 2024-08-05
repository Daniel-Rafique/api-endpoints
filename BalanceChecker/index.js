const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const TelegramNotifier = require('../Telegram');
const WalletProcessor = require('../WalletProcessor');
const WebSocket = require('ws');

const SOLANA_WEBSOCKET = process.env.SOLANA_WEBSOCKET_1;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_1;
const PROGRAM_ID = process.env.PROGRAM_ID;
const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS;
const TOKEN_PROGRAM_ID = new PublicKey(PROGRAM_ID);
const MINT_ADDRESS = new PublicKey(TOKEN_MINT_ADDRESS);
const { MESSAGES } = require('../constants');

const telegramToken = process.env.TELEGRAM_TOKEN;

class BalanceChecker {
  constructor(chatId, receiverPrivateKey, minimumSolBalance, minimumTokenBalance) {
    console.log('Receiver Private Key:', receiverPrivateKey);
    this.receiverKeypairString = receiverPrivateKey.toString();
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    this.receiverKeypair = Keypair.fromSecretKey(bs58.decode(this.receiverKeypairString));
    this.minimumSolBalance = minimumSolBalance;
    this.minimumTokenBalance = minimumTokenBalance;
    this.telegramNotifier = new TelegramNotifier(telegramToken);
    this.walletProcessor = new WalletProcessor();
    this.chatId = chatId;

    this.messageQueue = [];
    this.ws = null;
    this.pingInterval = null;
    this.listenForTransactions();
  }

  listenForTransactions() {
    this.ws = new WebSocket(SOLANA_WEBSOCKET);

    this.ws.on('open', () => {
      console.log('WebSocket connection opened');
      this.processMessageQueue();
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
    });

    this.ws.on('close', () => {
      console.log('WebSocket connection closed, reconnecting...');
      clearInterval(this.pingInterval);
      setTimeout(() => this.listenForTransactions(), 1000);
    });
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

      if (amountReceived < this.minimumSolBalance * 1e9 || tokenBalance < this.minimumTokenBalance) {
        console.log('Returning SOL to sender.');
        await this.returnSol(senderPublicKeyString, amountReceived);
        const message = MESSAGES.INSUFFICIENT_SOL(this.minimumSolBalance);
        if (amountReceived < this.minimumSolBalance * 1e9) {
          console.log('Sending insufficient SOL balance message.');
          await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
        }
      } else {
        console.log(`Transaction is valid. Amount received: ${amountReceived / 1e9} SOL`);
        await this.telegramNotifier.sendTelegramMessage(
          this.chatId,
          `✅ Received ${amountReceived / 1e9} SOL from ${senderPublicKeyString} token balance is ${tokenBalance}`
        );
        await this.walletProcessor.addJob(`${this.chatId}`);
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
      account => account.account.data.parsed.info.mint === MINT_ADDRESS.toString()
    );

    if (!tokenAccount) {
      return 0;
    }

    const tokenBalance = parseFloat(tokenAccount.account.data.parsed.info.tokenAmount.uiAmount);
    console.log('Token Balance:', tokenBalance);

    if (tokenBalance < this.minimumTokenBalance) {
      await this.returnSol(senderPublicKeyString, amountReceived);
      const message = MESSAGES.INSUFFICIENT_TOKEN(this.minimumSolBalance);
      await this.telegramNotifier.sendTelegramMessage(this.chatId, message);
    }

    return tokenBalance;
  }

  async returnSol(senderPublicKeyString, amountReceived) {
    try {
      const estimatedFee = await this.getEstimatedFee();
      const amountToReturn = amountReceived - estimatedFee * 2; // Double the estimated fee
      const remainingBalance = await this.connection.getBalance(senderPublicKeyString);


      if (amountToReturn <= 0) {
        console.error('Amount to return is less than or equal to the transaction fee');
        return;
      }

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: this.receiverKeypair.publicKey,
          toPubkey: senderPublicKeyString,
          lamports: remainingBalance - getEstimatedFee(senderPublicKeyString)
        })
      );

      transaction.feePayer = this.receiverKeypair.publicKey;
      transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
      transaction.sign(this.receiverKeypair);

      const signature = await sendAndConfirmTransaction(this.connection, transaction, [this.receiverKeypair]);

      console.log(`Returned ${amountToReturn / 1e9} SOL to sender: ${senderPublicKeyString}`);
      await this.telegramNotifier.sendTelegramMessage(
        this.chatId,
        `✅ Returned ${amountToReturn / 1e9} SOL to sender: ${senderPublicKeyString}. TX signature: ${signature}`
      );
    } catch (error) {
      console.error('Error returning SOL to sender:', error);
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
    console.log(value);
    return value;
  }
}

module.exports = BalanceChecker;
