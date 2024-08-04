require('dotenv').config();
// Initialize Firebase Admin with service account
const admin = require('firebase-admin');
const serviceAccount = require('./.config/firebaseServiceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const fs = require('fs');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const DataManager = require('./database');
const BalanceChecker = require('./BalanceChecker');
const TelegramNotifier = require('./Telegram');

const dataManager = new DataManager();
const app = express();
const port = process.env.PORT || (process.env.NODE_ENV === 'prod' ? 443 : 3443);

// Load environment variables for SSL
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
let tokenMintAddress;

// Function to generate the hash
function generateHash(chatId, timestamp) {
    const data = `${chatId}:${timestamp}:${SECRET_KEY}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

// Initialize TelegramNotifier
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramNotifier = new TelegramNotifier(telegramToken);

// Endpoint to handle incoming POST requests
app.post('/api/create', async (req, res) => {
    const { chatId, timestamp, hash } = req.body;

    // Validate parameters
    if (!chatId || !hash) {
        return res.status(400).send('Missing required parameters');
    }

    // Validate the hash
    const expectedHash = generateHash(chatId, timestamp);

    if (hash !== expectedHash) {
        console.log(`Hash mismatch! Expected: ${expectedHash}, Received: ${hash}`);
        return res.status(403).send('Invalid request signature');
    }

    try {
        const userData = await dataManager.getCollection(chatId.toString());    
        if (!userData) {
            return res.status(404).send('User data not found');
        }

        const minimumSolBalance = 0.1; 
        const receiverPublicKey = userData.wallet.toString();
        const minimumTokenBalance = process.env.MINIMUM_TOKEN_BALANCE;

        if(userData.boostType === 'ultra_boost') {
            tokenMintAddress = userData.contractAddress;
        } else {
            tokenMintAddress = process.env.TOKEN_MINT_ADDRESS;
        }

        // Start the periodic check
        const receiverPrivateKey = userData.walletPk.toString();
        if (typeof receiverPrivateKey !== 'string') {
            throw new TypeError('Receiver private key must be a string');
          }
        const balanceChecker = new BalanceChecker(
            [process.env.SOLANA_RPC_ENDPOINT_1, process.env.SOLANA_RPC_ENDPOINT_2],
            telegramNotifier,
            receiverPrivateKey
        );
        balanceChecker.startPeriodicCheck(chatId, receiverPublicKey, minimumSolBalance, minimumTokenBalance, tokenMintAddress);
        telegramNotifier.sendTelegramMessage(chatId, `🔍 Waiting for ${minimumSolBalance} SOL to be confirmed...`);
        res.status(200).send('Checking balance...');
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Create HTTPS server
const server = https.createServer(options, app);
server.setTimeout(10 * 60 * 1000); // Set timeout to 10 minutes
server.listen(port, () => {
    console.log(`HTTPS server is running on port ${port}`);
});