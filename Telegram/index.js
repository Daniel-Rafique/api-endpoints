const balanceText = require('../constants');
class Telegram {
  constructor(telegramToken) {
    this.telegramApiUrl = `https://api.telegram.org/bot${telegramToken}`;
  }

  async sendTelegramMessage(chatId, text, options = {}) {
    const url = `${this.telegramApiUrl}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          ...options
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }

  async sendTelegramBalanceCheckMessage(chatId, options = {}) {
    const url = `${this.telegramApiUrl}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: balanceText.MESSAGES.BALANCE_CHECK,
          ...options
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error sending message:', error);
    }
  }
}

module.exports = Telegram;
