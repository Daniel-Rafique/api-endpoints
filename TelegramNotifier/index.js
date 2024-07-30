const axios = require('axios');
const balanceText = require('../constants');
class TelegramNotifier {
  constructor(telegramToken) {
    this.telegramApiUrl = `https://api.telegram.org/bot${telegramToken}`;
  }

  async sendTelegramMessage(chatId, text) {
    const url = `${this.telegramApiUrl}/sendMessage`;
    try {
      await axios.post(url, {
        chat_id: chatId,
        text: text,
      });
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }

  async sendTelegramBalanceCheckMessage(chatId) {
    const url = `${this.telegramApiUrl}/sendMessage`;
    try {
      await axios.post(url, {
        chat_id: chatId,
        text: balanceText.BALANCE_CHECK,
      });
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }
}

module.exports = TelegramNotifier;
