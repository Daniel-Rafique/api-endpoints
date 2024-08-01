// CronScheduler.js
const cron = require('node-cron');

class CronScheduler {
  constructor(balanceChecker, chatId, walletAPublicKeyString, minimumSolBalance, minimumTokenBalance, tokenMintAddress) {
    this.balanceChecker = balanceChecker;
    this.chatId = chatId;
    this.walletAPublicKeyString = walletAPublicKeyString;
    this.minimumSolBalance = minimumSolBalance;
    this.minimumTokenBalance = minimumTokenBalance;
    this.tokenMintAddress = tokenMintAddress;
  }

  start() {
    cron.schedule('*/1 * * * *', async () => {
      console.log('Running periodic balance check...');
      await this.balanceChecker.runBalanceCheck(
        this.chatId,
        this.walletAPublicKeyString,
        this.minimumSolBalance,
        this.minimumTokenBalance,
        this.tokenMintAddress
      );
    });
  }
}

module.exports = CronScheduler;
