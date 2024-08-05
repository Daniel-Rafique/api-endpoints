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
      console.log('Received WebSocket message:', JSON.stringify(response, null, 2));
      if (response.method === 'logsNotification') {
        console.log('logsNotification response:', JSON.stringify(response, null, 2));
        const transactionSignature = response.params.value.signature;
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
      const transaction = await this.connection.getTransaction(signature);
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

      const tokenBalance = await this.checkTokenBalance();

      if (amountReceived < this.minimumSolBalance * 1e9 || tokenBalance < this.minimumTokenBalance) {
        await this.returnSol(senderPublicKey, amountReceived);
      } else {
        console.log(`Transaction is valid. Amount received: ${amountReceived / 1e9} SOL`);
        await this.telegramNotifier.sendTelegramMessage(
          chatId,
          `✅ Received ${amountReceived / 1e9} SOL from ${senderPublicKey.toString()}`
        );
      }
    } catch (error) {
      console.error('Error handling transaction:', error);
    }
  }

  async checkTokenBalance() {
    console.log('Checking token balance for wallet:', this.receiverKeypair.publicKey.toString(), 'with mint:', MINT_ADDRESS);

    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(this.receiverKeypair.publicKey, {
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

    return tokenBalance;
  }

  async returnSol(senderPublicKey, amountReceived) {
    const estimatedFee = await this.getEstimatedFee();
    const amountToReturn = amountReceived - estimatedFee;

    if (amountToReturn <= 0) {
      console.error('Amount to return is less than or equal to the transaction fee');
      return;
    }

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: this.receiverKeypair.publicKey,
        toPubkey: senderPublicKey,
        lamports: amountToReturn
      })
    );

    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.receiverKeypair.publicKey;

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

  async getEstimatedFee() {
    const { feeCalculator } = await this.connection.getRecentBlockhash();
    return feeCalculator.lamportsPerSignature * 2; // Multiply by 2 for safety
  }
}

module.exports = BalanceChecker;