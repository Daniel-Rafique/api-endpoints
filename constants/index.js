const MESSAGES = {
  BALANCE_CHECK_REPORT: '🔍 Balance check report:',
  SOL_BALANCE_A: (balance) => `💰 SOL balance of Wallet A: ${balance} SOL`,
  TOKEN_BALANCE_B: (balance) => `💸 Token balance of Wallet B: ${balance}`,
  SUFFICIENT_BALANCE: '✅ Both balances are sufficient.',
  INSUFFICIENT_SOL: (minBalance) => `❌ Insufficient SOL balance. Minimum required: ${minBalance} SOL.`,
  INSUFFICIENT_TOKEN: (minBalance) => `❌ Insufficient token balance. Minimum required: ${minBalance}`,
  RETURNED_SOL_PENDING: (balance) => `⏳ Returning ${balance} SOL (pending...)`,
  RETURNED_SOL_SUCCESS: (balance, signature) => `🔄 Returned ${balance} SOL successfully. Transaction signature: \`${escapeMarkdown(signature)}\``,
  INSUFFICIENT_FUNDS_FOR_RENT: (minBalance) => `❌ Wallet B does not have enough funds to be rent-exempt. Minimum required: ${(minBalance / 1_000_000_000).toFixed(9)} SOL.`,
  INSUFFICIENT_FUNDS: '❌ Transaction failed due to insufficient funds.',
  UNEXPECTED_ERROR: (message) => `⚠️ Unexpected error during balance check: ${message}`,
  ERROR_DURING_CHECK: (message) => `⚠️ Error during balance check: ${message}`
};

module.exports = {
  MESSAGES
};
