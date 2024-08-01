const axios = require('axios');
const balanceText = require('../Constants');
class Telegram {
  constructor(telegramToken) {
    this.telegramApiUrl = `https://api.telegram.org/bot${telegramToken}`;
  }

  async sendTelegramMessage(chatId, text, options = {}) {
    const url = `${this.telegramApiUrl}/sendMessage`;
    try {
      await axios.post(url, {
        chat_id: chatId,
        text: text,
        ...options
      });
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }

  async sendTelegramBalanceCheckMessage(chatId, options = {}) {
    const url = `${this.telegramApiUrl}/sendMessage`;
    try {
      await axios.post(url, {
        chat_id: chatId,
        text: balanceText.MESSAGES.BALANCE_CHECK,
        ...options
      });
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }
}

module.exports = Telegram;
