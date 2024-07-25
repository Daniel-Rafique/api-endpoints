const { Connection, PublicKey } = require('@solana/web3.js');
const { Queue, Worker } = require('bullmq');
const axios = require('axios');
const WalletWorker = require('./wallet');

class TransactionManager {
    constructor(rpcEndpoint, telegramToken, queueName = 'transactionQueue', connectionOptions = { host: 'localhost', port: 6379 }) {
        this.connection = new Connection(rpcEndpoint, 'confirmed');
        this.telegramToken = telegramToken;
        this.telegramApiUrl = `https://api.telegram.org/bot${telegramToken}`;

        this.worker = new Worker(queueName, async job => {
            const { chatId, publicKey, minimumSol, boostType, count, contractAddress } = job.data;

            try {
                const isValid = await this.checkBalance(publicKey, minimumSol);
                if (isValid) {
                    await this.sendTelegramMessage(chatId, `Your balance has been confirmed. Your wallet balance is sufficient.`);
                    await this.createWallets(chatId, boostType, count, contractAddress);
                } else {
                    await this.sendTelegramMessage(chatId, `Your balance does not meet the required minimum SOL.`);
                }
            } catch (error) {
                console.error('Error processing balance check job:', error);
            }
        }, {
            connection: connectionOptions
        });

        this.queue = new Queue(queueName, {
            connection: connectionOptions
        });

        this.walletWorker = new WalletWorker(walletManager, instanceInitializer, 'walletQueue', connectionOptions);
    }

    async checkBalance(publicKeyString, minimumSol) {
        try {
            const publicKey = new PublicKey(publicKeyString);
            const balance = await this.connection.getBalance(publicKey);
            const solBalance = balance / 1_000_000_000; // Convert lamports to SOL

            return solBalance >= minimumSol;
        } catch (error) {
            console.error('Error checking balance:', error);
            throw error;
        }
    }

    async createWallets(chatId, boostType, count, contractAddress) {
        await this.walletWorker.worker.add('createWallets', { chatId, boostType, count, contractAddress });
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
