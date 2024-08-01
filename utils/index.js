function escapeMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');
}
  module.exports = {
    escapeMarkdown,
  };
  