function escapeMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
             .replace(/\\/g, '\\\\')
             .replace(/\(/g, '\\(')
             .replace(/\)/g, '\\)');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTokenAmount(amount) {
  if (amount >= 1e9) {
    return `${(amount / 1e9).toFixed(0)}B`;  // Billions
  } else if (amount >= 1e6) {
    return `${(amount / 1e6).toFixed(0)}M`;  // Millions
  } else if (amount >= 1e3) {
    return `${(amount / 1e3).toFixed(0)}K`;  // Thousands
  } else {
    return amount.toFixed(0);  // Less than 1,000
  }
}

module.exports = {
  escapeMarkdown,
  formatTokenAmount,
  sleep
};