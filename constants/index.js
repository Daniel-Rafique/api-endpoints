const { escapeMarkdown } = require('../utils');

const MESSAGES = {
  BALANCE_CHECK_REPORT: `🔍 *Balance Check Report:*`,
  SOL_BALANCE_A: (solBalance) => `\n💰 SOL Balance is: ${escapeMarkdown(solBalance.toFixed(2))} SOL\\.`,
  TOKEN_BALANCE_B: (tokenBalance) => `\n🪙 Token Balance of sender: ${escapeMarkdown(tokenBalance.toFixed(2))} tokens\\.`,
  INSUFFICIENT_SOL: (minimumSolBalance) => `\n❌ The SOL balance does not meet the required minimum of ${escapeMarkdown(minimumSolBalance.toString())} SOL\\.`,
  INSUFFICIENT_TOKEN: (minimumTokenBalance) => `\n❌ The Token balance does not meet the required minimum of ${escapeMarkdown(minimumTokenBalance.toString())} tokens\\.`,
  SUFFICIENT_BALANCE: `\n✅ Both balances meet the required minimums\\.`,
  RETURNED_SOL: (solBalance, transactionSignature) => `\n🔄 Returned ${escapeMarkdown(solBalance.toFixed(2))} SOL to sender\\. \nTransaction signature: ${escapeMarkdown(transactionSignature)}`,
  ERROR_DURING_CHECK: (errorMessage) => `\n❌ Error during balance check: ${escapeMarkdown(errorMessage)}`,
};

module.exports = {
  MESSAGES,
};