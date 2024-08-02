const { Queue, Worker } = require('bullmq');
const { PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
const { connection, walletAKeypair } = require('./config'); // Adjust the import as per your configuration

// Create a queue
const solDistributionQueue = new Queue('SolDistribution');

// Worker to process jobs
const worker = new Worker('SolDistribution', async job => {
  const { creatorsWallet, wallets, totalAmount } = job.data;

  const lamportsToSend = (totalAmount * 1_000_000_000) - 5000; // Adjust for fees

  // Calculate amounts to distribute
  const creatorsAmount = lamportsToSend * 0.25;
  const perWalletAmount = (lamportsToSend * 0.75) / wallets.length;

  const transactions = [];

  // Create transaction for creator's wallet
  const creatorsTransaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: walletAKeypair.publicKey,
      toPubkey: new PublicKey(creatorsWallet),
      lamports: creatorsAmount,
    })
  );
  transactions.push(creatorsTransaction);

  // Create transactions for each wallet
  wallets.forEach(wallet => {
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: walletAKeypair.publicKey,
        toPubkey: new PublicKey(wallet),
        lamports: perWalletAmount,
      })
    );
    transactions.push(transaction);
  });

  // Send transactions
  const promises = transactions.map(tx =>
    sendAndConfirmTransaction(connection, tx, [walletAKeypair])
  );

  await Promise.all(promises);

  return 'SOL distributed successfully';
});

module.exports = solDistributionQueue;