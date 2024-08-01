// QueueProcessor.js
const { Queue, Worker, QueueScheduler } = require('bullmq');

class Queue {
  constructor(redisOptions, telegramNotifier, walletAKeypair) {
    this.transactionQueue = new Queue('transactionQueue', { connection: redisOptions });
    new QueueScheduler('transactionQueue', { connection: redisOptions });

    this.worker = new Worker('transactionQueue', async job => {
      const { walletBPublicKeyString, solBalanceA, chatId, walletAPrivateKey } = job.data;
      const balanceChecker = new BalanceChecker(new Connection(process.env.SOLANA_RPC_ENDPOINT), Keypair.fromSecretKey(bs58.decode(walletAPrivateKey)));
      const signature = await balanceChecker.returnSolToWalletB(walletBPublicKeyString, solBalanceA);
      return { signature, chatId, solBalanceA, walletAPrivateKey };
    }, { connection: redisOptions });

    this.worker.on('completed', async (job, result) => {
      const message = MESSAGES.RETURNED_SOL(result.solBalanceA, result.signature);
      const balanceChecker = new BalanceChecker(new Connection(process.env.SOLANA_RPC_ENDPOINT), Keypair.fromSecretKey(bs58.decode(result.walletAPrivateKey)));
      await balanceChecker.sendTelegramMessage(result.chatId, message);
    });

    this.worker.on('failed', (job, err) => {
      console.error(`Transaction job failed: ${job.id}`, err);
    });
  }

  addJob(data) {
    this.transactionQueue.add('returnSol', data);
  }
}

module.exports = Queue;