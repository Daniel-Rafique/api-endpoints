function escapeMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

module.exports = {
  escapeMarkdown,
};
