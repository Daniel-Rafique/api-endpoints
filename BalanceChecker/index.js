require('dotenv').config();
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
    console.log(receiverPrivateKey)
    this.receiverKeypairString = receiverPrivateKey.toString() 
    this.connection = new Connection(SOLANA_RPC_ENDPOINT, 'confirmed');
    this.receiverKeypair = Keypair.fromSecretKey(bs58.decode(this.receiverKeypairString));
    this.minimumSolBalance = minimumSolBalance;
    this.minimumTokenBalance = minimumTokenBalance;
    this.telegramNotifier = new TelegramNotifier();

    this.ws = null;
    this.listenForTransactions(chatId);
  }

  listenForTransactions(chatId) {
    if (this.ws) {
      this.ws.close();
    }

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
      this.switchWebSocketEndpoint();
      setTimeout(() => this.listenForTransactions(), 1000);
    });
  }

  async handleTransaction(chatId, signature) {
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

      const tokenBalance = await this.checkTokenBalance();

      if (amountReceived < this.minimumSolBalance * 1e9 || tokenBalance < this.minimumTokenBalance) {
        await this.returnSol(senderPublicKey, amountReceived);
      }
    } catch (error) {
      console.error('Error handling transaction:', error);
    }
  }

  async checkTokenBalance() {
    
    return this.retryOperation(async () => {
      console.log('Checking token balance for wallet:', this.receiverKeypair.publicKey.toString(),
       'with mint:', MINT_ADDRESS);
      const walletPublicKey = new PublicKey(walletPublicKeyString);
      const tokenMintPublicKey = new PublicKey(tokenMintAddress);

      console.log('Validated Wallet Public Key:', walletPublicKey.toString());
      console.log('Validated Token Mint Address:', tokenMintPublicKey.toString());

      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(walletPublicKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      console.log('Fetched Token Accounts:', JSON.stringify(tokenAccounts, null, 2));

      if (!tokenAccounts) {
        console.warn('No token accounts found.');
        return 0;
      }

      const tokenAccount = tokenAccounts.value.find(
        account => account.account.data.parsed.info.owner === walletPublicKey.toString()
      );

      if (!tokenAccount) {
        console.warn('No token account matching the mint address found.');
        return 0;
      }

      const tokenBalance = parseFloat(tokenAccount.account.data.parsed.info.tokenAmount.uiAmount);
      console.log('Token Balance:', tokenBalance);

      return tokenBalance;
    });
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
        lamports: amountToReturn - estimatedFee
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

  async retryOperation(operation, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          this.limiter.removeTokens(1, (err, remainingRequests) => {
            if (err) reject(err);
            else resolve(remainingRequests);
          });
        });

        return await operation();
      } catch (error) {
        if (attempt === maxRetries - 1) throw error;
        console.log(`Attempt ${attempt + 1} failed, retrying...`);
        this.switchRpcEndpoint();
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  async getEstimatedFee() {
    const { feeCalculator } = await this.connection.getRecentBlockhash();
    return feeCalculator.lamportsPerSignature * 2; // Multiply by 2 for safety
  }
}

module.exports = BalanceChecker;