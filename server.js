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
const Solana = require('./Solana');
const InstanceInitializer = require('./InstanceInitializer');

const dataManager = new DataManager();
const solana = new Solana();
const instanceInitializer = new InstanceInitializer();

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

        const minimumSolBalance = 0.05; 
        const receiverPublicKey = userData.wallet;
        const minimumTokenBalance = process.env.MINIMUM_TOKEN_BALANCE;

        if(userData.boostType === 'ultra_boost') {
            contractAddress = userData.contractAddress;
        } else {
            tokenMintAddress = process.env.TOKEN_MINT_ADDRESS;
        }

        // Start the periodic check
        let receiverPrivateKey = userData.walletPk;
        console.log('Type of receiverPrivateKey before conversion:', typeof receiverPrivateKey);
        receiverPrivateKey = receiverPrivateKey.toString();
        console.log('Type of receiverPrivateKey after conversion:', typeof receiverPrivateKey);
        console.log('Value of receiverPrivateKey:', receiverPrivateKey);

        if (typeof receiverPrivateKey !== 'string') {
            throw new TypeError('Receiver private key must be a string');
        }
        const websocket = new BalanceChecker(
            chatId,
            receiverPrivateKey,
            minimumSolBalance,
            minimumTokenBalance,
            telegramToken,
            contractAddress
        );

        if (!userData?.walletsCreated) {
            websocket.listenForTransactions(chatId, receiverPublicKey);
            telegramNotifier.sendTelegramMessage(chatId, `🔍 Waiting for ${minimumSolBalance} SOL to be confirmed...`);
            res.status(200).send('Checking balance...');
        } else if (userData?.walletsCreated && !userData.distributeSolana) {
            await solana.distributeSolana(chatId);
            res.status(200).send('Airdropping SOL...');
        } else if (userData.distributeSolana) {
            await instanceInitializer.initializeMarketMakerInstance(chatId);
            res.status(200).send('Instances created...');
        }
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