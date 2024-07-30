require('dotenv').config();

const fs = require('fs');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const BalanceChecker = require('./BalanceChecker');
const TelegramNotifier = require('./TelegramNotifier'); 
const DataManager = require('./database');

const dataManager = new DataManager();

const app = express();
const port = process.env.PORT;

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
function generateHash(chatId, timestamp) {
    const data = `${chatId}:${timestamp}:${SECRET_KEY}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

// Initialize TelegramNotifier
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramNotifier = new TelegramNotifier(telegramToken);

// Initialize BalanceChecker
const rpcEndpoints = [
    process.env.SOLANA_RPC_ENDPOINT_1,
    process.env.SOLANA_RPC_ENDPOINT_2,
]

// Endpoint to handle incoming POST requests
app.post('/api/create', async (req, res) => {
    const {
        chatId,
        timestamp,
        hash
    } = req.body;

    console.log(req.body);

    // Validate parameters
    if (!chatId || !hash ) {
        return res.status(400).send('Missing required parameters');
    }

    // Validate the hash
    const expectedHash = generateHash(chatId, timestamp);
    if (hash !== expectedHash) {
        console.log(expectedHash);
        return res.status(403).send('Invalid request signature');
    }
    const userData = await dataManager.getCollection(chatId);

    // Start the periodic check
    const walletASecretKey = userData.walletPk;

    const balanceChecker = new BalanceChecker(rpcEndpoints, telegramNotifier, walletASecretKey);
    
    balanceChecker.startPeriodicCheck(chatId);
    telegramNotifier.sendTelegramBalanceCheckMessage(chatId);
    res.status(200).send('Checking balance...');
});

const server = https.createServer(options, app);
server.setTimeout(10 * 60 * 1000); // Set timeout to 10 minutes
server.listen(port, () => {
    console.log(`HTTPS server is running on port ${port}`);
});