require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const admin = require('firebase-admin');
const BalanceChecker = require('./BalanceChecker'); // Ensure correct case
const TelegramNotifier = require('./TelegramNotifier'); // Ensure correct case

const app = express();
const port = process.env.PORT;

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: process.env.DATABASE_URL
});

// Load environment variables
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;

// SSL options
const options = {
    key: fs.readFileSync(SSL_KEY_PATH),
    cert: fs.readFileSync(SSL_CERT_PATH)
};

// Middleware
app.use(bodyParser.json());

// Secret key (store this securely, e.g., in environment variables)
const SECRET_KEY = process.env.SECRET_KEY;

// Function to generate the hash
function generateHash(chatId, contractAddress, boostType, boostCost, wallet, walletPk, batchSize, makers, timestamp) {
    const data = `${chatId}:${contractAddress}:${boostType}:${boostCost}:${wallet}:${walletPk}:${batchSize}:${makers}:${timestamp}:${SECRET_KEY}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

// Initialize TelegramNotifier
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramNotifier = new TelegramNotifier(telegramToken);

// Initialize BalanceChecker
const rpcEndpoints = [
    process.env.SOLANA_RPC_ENDPOINT_1,
    process.env.SOLANA_RPC_ENDPOINT_2,
];
const walletASecretKey = process.env.WALLET_A_SECRET_KEY;
const interval = process.env.CRON_JOB_INTERVAL || '*/1 * * * *';

const balanceChecker = new BalanceChecker(rpcEndpoints, telegramNotifier, walletASecretKey);

// Endpoint to handle incoming POST requests
app.post('/api/create', async (req, res) => {
    const {
        chatId,
        contractAddress,
        boostType,
        boostCost,
        wallet,
        walletPk,
        batchSize,
        makers,
        timestamp,
        hash
    } = req.body;

    console.log(req.body);

    // Validate parameters
    if (!chatId || !contractAddress || !boostType || !boostCost || !wallet || !walletPk || !batchSize || !timestamp || !hash || makers > 2000) {
        return res.status(400).send('Missing required parameters');
    }

    // Validate the hash
    const expectedHash = generateHash(chatId, contractAddress, boostType, boostCost, wallet, walletPk, batchSize, makers, timestamp);
    if (hash !== expectedHash) {
        console.log(expectedHash);
        return res.status(403).send('Invalid request signature');
    }

    // Start the periodic check
    balanceChecker.startPeriodicCheck(chatId, contractAddress, boostCost, wallet, walletPk, interval);
    telegramNotifier.sendTelegramBalanceCheckMessage(chatId);
    res.status(200).send('Checking balance...');
});

const server = https.createServer(options, app);
server.setTimeout(10 * 60 * 1000); // Set timeout to 10 minutes
server.listen(port, () => {
    console.log(`HTTPS server is running on port ${port}`);
});