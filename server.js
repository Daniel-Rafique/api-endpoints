require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccount = require('./.config/firebaseServiceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const DataManager = require('./database');

const fs = require('fs');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const BalanceChecker = require('./BalanceChecker');
const TelegramNotifier = require('./TelegramNotifier');

// Initialize Firebase Admin with service account
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
];

// Endpoint to handle incoming POST requests
app.post('/api/create', async (req, res) => {
    const { chatId, timestamp, hash } = req.body;

    console.log(req.body);
    console.log(`Received - chatId: ${chatId}, timestamp: ${timestamp}, hash: ${hash}`);
    console.log(`Server SECRET_KEY: ${SECRET_KEY}`); // Log the SECRET_KEY on the server

    // Validate parameters
    if (!chatId || !hash) {
        return res.status(400).send('Missing required parameters');
    }

    // Validate the hash
    const expectedHash = generateHash(chatId, timestamp);
    console.log(`Expected hash: ${expectedHash}`);

    if (hash !== expectedHash) {
        console.log(`Hash mismatch! Expected: ${expectedHash}, Received: ${hash}`);
        return res.status(403).send('Invalid request signature');
    }

    try {
        const userData = await dataManager.getCollection(chatId);
        if (!userData) {
            return res.status(404).send('User data not found');
        }

        // Start the periodic check
        const walletASecretKey = userData.walletPk;
        const balanceChecker = new BalanceChecker(rpcEndpoints, telegramNotifier, walletASecretKey);
        balanceChecker.startPeriodicCheck(chatId, userData);
        telegramNotifier.sendTelegramBalanceCheckMessage(chatId);
        res.status(200).send('Checking balance...');
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Internal Server Error');
    }
});

const server = https.createServer(options, app);
server.setTimeout(10 * 60 * 1000); // Set timeout to 10 minutes
server.listen(port, () => {
    console.log(`HTTPS server is running on port ${port}`);
});