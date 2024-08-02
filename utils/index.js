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

module.exports = {
  escapeMarkdown,
  sleep
};