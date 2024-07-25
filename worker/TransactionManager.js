const { Connection, PublicKey } = require('@solana/web3.js');
const { Queue, Worker } = require('bullmq');
const axios = require('axios');

class TransactionManager {
    constructor(rpcEndpoint, telegramToken, queueName = 'transactionQueue', connectionOptions = { host: 'localhost', port: 6379 }) {
        this.connection = new Connection(rpcEndpoint, 'confirmed');
        this.telegramToken = telegramToken;
        this.telegramApiUrl = `https://api.telegram.org/bot${telegramToken}`;

        this.worker = new Worker(queueName, async job => {
            const { chatId, publicKey, transactionId, minimumSol } = job.data;

            try {
                const isValid = await this.validateTransaction(publicKey, minimumSol);
                if (isValid) {
                    await this.sendTelegramMessage(chatId, `Your transaction has been confirmed. Your wallet balance is sufficient.`);
                } else {
                    await this.sendTelegramMessage(chatId, `Transaction is not valid or does not meet the required minimum SOL.`);
                }
            } catch (error) {
                console.error('Error processing transaction job:', error);
            }
        }, {
            connection: connectionOptions
        });

        this.queue = new Queue(queueName, {
            connection: connectionOptions
        });
    }

    async validateTransaction(publicKey, minimumSol) {
        try {
            const balance = await this.connection.getBalance(publicKey)

            console.log(balance)
            
            if (!balance) {
                throw new Error('Insufficient balance');
            }

            const lamportsTransferred = transaction.meta.postBalances[0] - transaction.meta.preBalances[0];
            const solTransferred = balance / 1_000_000_000;

            return solTransferred >= minimumSol;
        } catch (error) {
            console.error('Balance too low', error);
            throw error;
        }
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

    async addJob(data) {
        await this.queue.add('validateTransaction', data);
    }
}

module.exports = TransactionManager;
