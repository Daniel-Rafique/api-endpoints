require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, Keypair, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const WebSocket = require('ws');
const TelegramNotifier = require('../Telegram');

const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT_1;
const SOLANA_WEBSOCKET = process.env.SOLANA_WEBSOCKET_1;
const PROGRAM_ID = process.env.PROGRAM_ID;
const TOKEN_MINT_ADDRESS = process.env.TOKEN_MINT_ADDRESS;
const TOKEN_PROGRAM_ID = new PublicKey(PROGRAM_ID);
const MINT_ADDRESS = new PublicKey(TOKEN_MINT_ADDRESS);

class BalanceChecker {
  constructor(receiverPrivateKey, minimumSolBalance, minimumTokenBalance) {
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    this.receiverKeypair = Keypair.fromSecretKey(bs58.decode(receiverPrivateKey));
    this.minimumSolBalance = minimumSolBalance;
    this.minimumTokenBalance = minimumTokenBalance;
    this.tokenMintAddress = new PublicKey(tokenMintAddress);
    this.telegramNotifier = new TelegramNotifier();

    this.ws = null;
    this.listenForTransactions();
  }

  listenForTransactions() {
    this.ws = new WebSocket(SOLANA_WEBSOCKET);

    this.ws.on('open', () => {
      console.log('WebSocket connection opened');
      this.ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{
          mentions: [this.receiverKeypair.publicKey.toString()]
        }]
      }));
    });

    this.ws.on('message', async (data) => {
      const response = JSON.parse(data);
      if (response.method === 'logsNotification') {
        const transactionSignature = response.params.result.signature;
        if (transactionSignature) {
          await this.handleTransaction(transactionSignature);
        }
      }
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });

    this.ws.on('close', () => {
      console.log('WebSocket connection closed, attempting to reconnect...');
      setTimeout(() => this.listenForTransactions(), 5000);
    });
  }

  async handleTransaction(signature) {
    try {
      const transaction = await this.connection.getTransaction(signature);
      if (!transaction) {
        console.error('Failed to retrieve transaction');
        return;
      }

      const senderPublicKey = transaction.transaction.message.accountKeys.find(
        key => !key.equals(this.receiverKeypair.publicKey)
      );

      if (!senderPublicKey) {
        console.error('Sender public key not found in the transaction');
        return;
      }

      const amountReceived = transaction.meta.postBalances[transaction.transaction.message.accountKeys.findIndex(
        key => key.equals(this.receiverKeypair.publicKey)
      )] - transaction.meta.preBalances[transaction.transaction.message.accountKeys.findIndex(
        key => key.equals(this.receiverKeypair.publicKey)
      )];

      if (amountReceived <= 0) {
        console.error('Invalid transaction amount');
        return;
      }

      const tokenBalance = await this.checkTokenBalance(senderPublicKey);

      if (amountReceived < this.minimumSolBalance * 1e9 || tokenBalance < this.minimumTokenBalance) {
        await this.returnSol(senderPublicKey, amountReceived);
      }
    } catch (error) {
      console.error('Error handling transaction:', error);
    }
  }

  async checkTokenBalance(senderPublicKey) {
    const ownerPublicKey = new PublicKey(senderPublicKey);
    const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(MINT_ADDRESS, {
      mint: this.tokenMintAddress,
      programId: TOKEN_PROGRAM_ID
    });

    console.log('Fetched Token Accounts:', JSON.stringify(tokenAccounts, null, 2));

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    return parseFloat(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount);
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
      process.env.TELEGRAM_CHAT_ID,
      `✅ Returned ${amountToReturn / 1e9} SOL to sender: ${senderPublicKey.toString()}. TX signature: ${signature}`
    );
  }

  async getEstimatedFee() {
    const { feeCalculator } = await this.connection.getRecentBlockhash();
    return feeCalculator.lamportsPerSignature * 2; // Multiply by 2 for safety
  }
}

module.exports = BalanceChecker;