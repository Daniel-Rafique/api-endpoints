function escapeMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
             .replace(/\\/g, '\\\\')
             .replace(/\(/g, '\\(')
             .replace(/\)/g, '\\)');
}

module.exports = {
  escapeMarkdown,
};