const { escapeMarkdown } = require('../utils');

module.exports = {
  MESSAGES: {
    BALANCE_CHECK_REPORT: '🔍 *Balance Check Report* 🔍\n\n',
    SOL_BALANCE_A: (solBalance) => `💰 SOL Balance of Wallet A: \`${solBalance.toFixed(9)} SOL\`\n`,
    TOKEN_BALANCE_B: (tokenBalance) => `🪙 Token Balance of Wallet B: \`${tokenBalance} tokens\`\n`,
    SUFFICIENT_BALANCE: '✅ Both SOL balance in Wallet A and Token balance in Wallet B are sufficient.\n',
    INSUFFICIENT_SOL: (minimumSol) => `❌ Wallet A's SOL balance does not meet the required minimum of \`${minimumSol} SOL\`.\n`,
    INSUFFICIENT_TOKEN: (minimumToken) => `❌ Wallet B's Token balance does not meet the required minimum of \`${minimumToken} tokens\`.\n`,
    RETURNED_SOL: (solBalance, signature) => `🔄 Returned \`${solBalance} SOL\` to Wallet B. Transaction signature: \`${signature}\`\n`,
    ERROR_DURING_CHECK: (errorMessage) => `❌ Error during balance check: \`${escapeMarkdown(errorMessage)}\`\n`,
  },
};
