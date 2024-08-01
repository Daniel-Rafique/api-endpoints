const { escapeMarkdown } = require('../utils');

const MESSAGES = {
  BALANCE_CHECK_REPORT: '🔍 Balance Check Report:\n',
  SOL_BALANCE_A: (balance) => `💰 SOL Balance is: \`${balance.toFixed(9)} SOL\`\n`,
  TOKEN_BALANCE_B: (balance) => `🪙 Token Balance of sender: \`${balance} tokens\`\n`,
  SUFFICIENT_BALANCE: '✅ Both SOL and Token balances are sufficient.\n',
  INSUFFICIENT_SOL: (minBalance) => `❌ The SOL balance does not meet the required minimum of \`${minBalance} SOL\`.\n`,
  INSUFFICIENT_TOKEN: (minBalance) => `❌ The Token balance does not meet the required minimum of \`${minBalance} tokens\`.\n`,
  RETURNED_SOL: (amount, signature) => `🔄 Returned \`${amount.toFixed(9)} SOL\` to sender. Transaction signature: \`${escapeMarkdown(signature)}\`\n`,
  ERROR_DURING_CHECK: (error) => `❌ Error during balance check: \`${escapeMarkdown(error)}\`.\n`
};

module.exports = {
  MESSAGES,
};
