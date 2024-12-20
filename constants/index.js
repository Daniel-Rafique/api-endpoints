const { escapeMarkdown } = require('../utils');
const TOKEN = process.env.TOKEN;
const MINIMUM_TOKEN_BALANCE = parseFloat(process.env.MINIMUM_TOKEN_BALANCE);
const BALANCE_BITQUERY_TOKEN = process.env.BALANCE_BITQUERY_TOKEN;

const MESSAGES = {
  BALANCE_CHECK_REPORT: '🔍 Balance check report:',
  SOL_BALANCE: (balance) => `\n💰 SOL balance is: ${balance.toFixed(2)} SOL`,
  DEPLOYMENT: () => `\n🚀 Starting deployment🚀`,
  TOKEN_BALANCE: (balance) => `\n💸 Senders' ${escapeMarkdown(TOKEN)} balance is: ${balance.toFixed(2)}`,
  SUFFICIENT_BALANCE: '\n✅ Transfer received, starting deployment',
  INSUFFICIENT_SOL: (minBalance) => `\n❌ Insufficient SOL balance. Minimum required: ${minBalance.toFixed(2)} SOL`,
  TOPUP_SOL: (minBalance) => `\n❌ Your SOL balance is running low. Please arrange a topup: ${minBalance.toFixed(2)} SOL`,
  INSUFFICIENT_TOKEN: (minBalance) => `\n❌ Insufficient ${escapeMarkdown(TOKEN)} balance. Minimum required: ${MINIMUM_TOKEN_BALANCE.toFixed(2)}`,
  RETURNED_SOL_PENDING: (balance) => `\n⏳ Returning ${balance.toFixed(2)} SOL (pending...)`,
  RETURNED_SOL_SUCCESS: (balance, signature) => `\n🔄 Returned ${balance.toFixed(2)} SOL successfully here is your transaction ID: \n ${signature}`,
  INSUFFICIENT_FUNDS_FOR_RENT: (minBalance) => `\n❌ Sender does not have enough funds to be rent-exempt. Minimum required: ${(minBalance / 1_000_000_000).toFixed(2)} SOL`,
  INSUFFICIENT_FUNDS: '\n❌ Transaction failed due to insufficient funds',
  UNEXPECTED_ERROR: (message) => `\n⚠️ Unexpected error during balance check: ${message}`,
  ERROR_DURING_CHECK: (message) => `\n⚠️ Error during balance check: ${message}`,
  RETURNED_SOL_FAILURE: (balance) => `\n❌ Failed to return ${balance.toFixed(2)} SOL`,
  TOPUP_SUCCESS: (amount) => `🎉 Top-up Successful! 🎉\nWe've received your deposit of ${amount} SOL. Your account balance has been updated.
Current balance: [Insert updated balance here] SOL`,
};

module.exports = {
  BALANCE_BITQUERY_TOKEN,
  MESSAGES
};
