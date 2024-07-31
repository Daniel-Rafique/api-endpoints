const { escapeMarkdown } = require('../utils');

module.exports = {
  MESSAGES: {
    BALANCE_CHECK_REPORT: '🔍 *Balance Update* 🔍\n\n',
    SOL_BALANCE_A: (solBalance) => `💰 SOL Balance is: \`${escapeMarkdown(solBalance.toFixed(9))} SOL\`\n`,
    TOKEN_BALANCE_B: (tokenBalance) => `🪙 Token Balance of sender: \`${escapeMarkdown(tokenBalance)} tokens\`\n`,
    SUFFICIENT_BALANCE: '✅ Both SOL balance and Token balance are sufficient - activating...\n',
    INSUFFICIENT_SOL: (minimumSolBalance) => `❌ The SOL balance does not meet the required minimum of \`${escapeMarkdown(minimumSolBalance)} SOL\`.\n`,
    INSUFFICIENT_TOKEN: (minimumTokenBalance) => `❌ The Token balance does not meet the required minimum of \`${escapeMarkdown(minimumTokenBalance)} tokens\`\n`,
    RETURNED_SOL: (solBalance, signature) => `🔄 Returned \`${escapeMarkdown(solBalance)} SOL\` to sender. Transaction signature: \`${escapeMarkdown(signature)}\`\n`,
    ERROR_DURING_CHECK: (errorMessage) => `❌ Error during balance check: \`${escapeMarkdown(errorMessage)}\`\n`,
  },
};