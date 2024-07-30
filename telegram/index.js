require('dotenv').config();
const { Connection, PublicKey, Transaction, SystemProgram, Keypair } = require('@solana/web3.js');
const axios = require('axios');
const text = require('../constants');

class Telegram {

    async sendTelegramBalanceCheckMessage(chatId) {
        const url = `${this.telegramApiUrl}/sendMessage`;
        try {
          await axios.post(url, {
            chat_id: chatId,
            text: text.TRANSACTION_CHECK,
          });
        } catch (error) {
          console.error('Error sending message:', error);
        }
      }

}

exports.Telegram = Telegram;
