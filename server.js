require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { Queue } = require('bullmq');
const TransactionManager = require('./worker/TransactionManager');

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: ""
});

const app = express();
const port = process.env.PORT || 443;

// SSL options
const options = {
    key: fs.readFileSync('/etc/letsencrypt/live/bot.koynlabs.com/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/bot.koynlabs.com/fullchain.pem')
};

// Middleware
app.use(bodyParser.json());

// Secret key (store this securely, e.g., in environment variables)
const SECRET_KEY = process.env.SECRET_KEY;
const SOLANA_RPC_ENDPOINT = process.env.SOLANA_RPC_ENDPOINT; // Solana RPC endpoint
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // Telegram bot token

// Function to generate the hash
function generateHash(chatId, transactionId, timestamp) {
    const data = `${chatId}:${transactionId}:${timestamp}:${SECRET_KEY}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

// BullMQ queues
const walletQueue = new Queue('walletQueue', {
    connection: {
        host: 'localhost',
        port: 6379
    }
});

// Initialize TransactionManager
const transactionManager = new TransactionManager(SOLANA_RPC_ENDPOINT, TELEGRAM_TOKEN);

// Endpoint to handle wallet creation requests
app.post('/api/create', async (req, res) => {
    const { chatId, boostType, count, timestamp, hash } = req.body;

    // Validate parameters
    if (!chatId || !boostType || !count || !timestamp || !hash || count > 1000) {
        return res.status(400).send('Missing required parameters or invalid walletCount');
    }

    // Validate the hash
    const expectedHash = generateHash(chatId, boostType, timestamp);
    if (hash !== expectedHash) {
        return res.status(403).send('Invalid request signature');
    }

    // Add job to queue
    await walletQueue.add('createWallets', { chatId, boostType, count });

    res.status(200).send('Request received, processing in background');
});

// Endpoint to handle transaction requests
app.post('/api/transaction', async (req, res) => {
    const { chatId, transactionId, timestamp, hash, publicKey, minimumSol, count, contractAddress } = req.body;
    console.log("Transaction info received:")

    // Validate parameters
    if (!chatId || !transactionId || !timestamp || !hash || !publicKey || !minimumSol || !count || !contractAddress) {
        return res.status(400).send('Missing required parameters');
    }

    // Validate the hash
    const expectedHash = generateHash(chatId, transactionId, timestamp);
    if (hash !== expectedHash) {
        return res.status(403).send('Invalid request signature');
    }

    // Add job to queue
    await transactionManager.addJob({ chatId, publicKey, minimumSol, boostType, count, contractAddress });

    res.status(200).send('Request received, processing in background');
});

const server = https.createServer(options, app);
server.setTimeout(10 * 60 * 1000); // Set timeout to 10 minutes
server.listen(port, () => {
    console.log(`HTTPS server is running on port ${port}`);
});