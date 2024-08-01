const { escapeMarkdown } = require('../utils');

const MESSAGES = {
  BALANCE_CHECK_REPORT: "🔍 *Balance Check Report:*",
  SOL_BALANCE_A: (solBalance) => `\n💰 SOL Balance is: ${solBalance.toFixed(9)} SOL`,
  TOKEN_BALANCE_B: (tokenBalance) => `\n🪙 Token Balance of sender: ${tokenBalance.toFixed(9)} tokens`,
  INSUFFICIENT_SOL: (minimumSolBalance) => `\n❌ The SOL balance does not meet the required minimum of ${minimumSolBalance} SOL.`,
  INSUFFICIENT_TOKEN: (minimumTokenBalance) => `\n❌ The Token balance does not meet the required minimum of ${minimumTokenBalance} tokens.`,
  SUFFICIENT_BALANCE: "\n✅ Both balances meet the required minimums.",
  RETURNED_SOL: (solBalance, transactionSignature) => `\n🔄 Returned ${solBalance.toFixed(9)} SOL to sender. Transaction signature: [${transactionSignature}](https://solscan.io/tx/${transactionSignature})`,
  ERROR_DURING_CHECK: (errorMessage) => `\n❌ Error during balance check: ${errorMessage}`
};

module.exports = {
  MESSAGES,
};