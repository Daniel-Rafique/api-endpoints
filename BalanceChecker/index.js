// BalanceChecker.js
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('../constants');
const { getParsedTokenAccountsByOwner } = require('@solana/spl-token');

class BalanceChecker {
  constructor(connection, walletAKeypair) {
    this.connection = connection;
    this.walletAKeypair = walletAKeypair;
  }

  async checkSolBalance(publicKeyString) {
    try {
      const publicKey = new PublicKey(publicKeyString);
      const balance = await this.connection.getBalance(publicKey);
      return balance / 1_000_000_000; // Convert lamports to SOL
    } catch (error) {
      console.error('Error checking SOL balance:', error);
      throw error;
    }
  }

  async checkTokenBalance(walletPublicKeyString, tokenMintAddress) {
    try {
      const walletPublicKey = new PublicKey(walletPublicKeyString);
      const tokenMintPublicKey = new PublicKey(tokenMintAddress);

      const tokenAccounts = await getParsedTokenAccountsByOwner(
        this.connection,
        walletPublicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      if (tokenAccounts.value.length === 0) {
        console.warn('No token accounts found.');
        return 0;
      }

      const tokenAccount = tokenAccounts.value.find(
        account => account.account.data.parsed.info.mint === tokenMintPublicKey.toBase58()
      );

      if (!tokenAccount) {
        console.warn('No token account matching the mint address found.');
        return 0;
      }

      const tokenBalance = parseFloat(tokenAccount.account.data.parsed.info.tokenAmount.uiAmount);
      return tokenBalance;
    } catch (error) {
      console.error('Error checking token balance:', error);
      throw error;
    }
  }
}

module.exports = BalanceChecker;