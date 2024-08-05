const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const WebSocket = require('ws');
const TelegramNotifier = require('../Telegram');

const SOLANA_WEBSOCKET = process.env.SOLANA_WEBSOCKET_1;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_1;
const PROGRAM_ID = process.env.PROGRAM_ID;
const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS;
const TOKEN_PROGRAM_ID = new PublicKey(PROGRAM_ID);
const MINT_ADDRESS = new PublicKey(TOKEN_MINT_ADDRESS);
const { MESSAGES } = require('../constants');

class BalanceChecker {
  constructor(chatId, receiverPrivateKey, minimumSolBalance, minimumTokenBalance) {
    console.log('Receiver Private Key:', receiverPrivateKey);
    this.receiverKeypairString = receiverPrivateKey.toString();
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    this.receiverKeypair = Keypair.fromSecretKey(bs58.decode(this.receiverKeypairString));
    this.minimumSolBalance = minimumSolBalance;
    this.minimumTokenBalance = minimumTokenBalance;
    this.telegramNotifier = new TelegramNotifier();

    this.messageQueue = [];
    this.ws = null;
    this.listenForTransactions(chatId);
  }

  listenForTransactions(chatId) {
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
    });

    this.ws.on('message', async (data) => {
      const response = JSON.parse(data);
      console.log('Received WebSocket message:', response);
      if (response.method === 'logsNotification') {
        const transactionSignature = response.params.result.value.signature;
        console.log(`New transaction: ${transactionSignature}`);
        if (transactionSignature) {
          await this.handleTransaction(chatId, transactionSignature);
        }
      }
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    this.ws.on('close', () => {
      console.log('WebSocket connection closed, reconnecting...');
      setTimeout(() => this.listenForTransactions(chatId), 1000);
    });
  }

  sendMessage(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      console.log('Sending message:', message);
      this.ws.send(JSON.stringify(message));
    } else {
      console.log('WebSocket not open, queueing message:', message);
      this.messageQueue.push(message);
    }
  }

  processMessageQueue() {
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      this.sendMessage(message);
    }
  }

  async handleTransaction(chatId, signature) {
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

      const senderPublicKeyString = new PublicKey(senderPublicKey);

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

      const tokenBalance = await this.checkTokenBalance(senderPublicKeyString);

      if (amountReceived < this.minimumSolBalance * 1e9 || tokenBalance < this.minimumTokenBalance) {

        const message = MESSAGES.INSUFFICIENT_SOL(this.minimumSolBalance);
        if(amountReceived < this.minimumSolBalance * 1e9) {
          await this.telegramNotifier.sendTelegramMessage(chatId, message);
        }

        await this.returnSol(senderPublicKey, amountReceived);
      } else {
        console.log(`Transaction is valid Amount received: ${amountReceived / 1e9} SOL`);
        await this.telegramNotifier.sendTelegramMessage(
          chatId,`✅ Received ${amountReceived / 1e9} SOL from ${senderPublicKey.toString()} token balance is ${tokenBalance}`
        );
      }
    } catch (error) {
      console.error('Error handling transaction:', error);
    }
  }

  async checkTokenBalance(senderPublicKeyString) {
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

    if(tokenBalance < this.minimumTokenBalance) {
      const message = MESSAGES.INSUFFICIENT_TOKEN(this.minimumSolBalance);
      await this.telegramNotifier.sendTelegramMessage(chatId, message);
    }

    return tokenBalance;
  }

  async getEstimatedFee(transaction) {
    const versionedMessage = transaction.compileMessage();
    const { value: fee } = await this.connection.getFeeForMessage(versionedMessage);
    
    if (fee === null) {
      throw new Error('Failed to retrieve fee');
    }
  
    return fee;
  }
  
  async returnSol(senderPublicKey, amountReceived) {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.receiverKeypair.publicKey,
        toPubkey: senderPublicKey,
        lamports: amountReceived
      })
    );
  
    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.receiverKeypair.publicKey;
  
    const estimatedFee = await this.getEstimatedFee(transaction);
    const amountToReturn = amountReceived - estimatedFee;
  
    if (amountToReturn <= 0) {
      console.error('Amount to return is less than or equal to the transaction fee');
      return;
    }
  
    // Adjust the transaction for the actual return amount
    transaction.instructions[0] = SystemProgram.transfer({
      fromPubkey: this.receiverKeypair.publicKey,
      toPubkey: senderPublicKey,
      lamports: amountToReturn
    });
  
    const signature = await sendAndConfirmTransaction(
      this.connection,
      transaction,
      [this.receiverKeypair]
    );
  
    console.log(`Returned ${amountToReturn / 1e9} SOL to sender: ${senderPublicKey.toString()}`);
    await this.telegramNotifier.sendTelegramMessage(
      chatId,
      `✅ Returned ${amountToReturn / 1e9} SOL to sender: ${senderPublicKey.toString()}. TX signature: ${signature}`
    );
  }
  
}

module.exports = BalanceChecker;