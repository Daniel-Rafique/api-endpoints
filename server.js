require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { Queue, Worker } = require('bullmq');
const WalletManager = require('./walletManager');
const MarketMakerManager = require('./marketMakerManager');
const InstanceInitializer = require('./instanceInitializer');

const app = express();
const port = process.env.PORT

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: ""
});

// Load environment variables
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;

// SSL options
const options = {
    key: fs.readFileSync(SSL_KEY_PATH),
    cert: fs.readFileSync(SSL_CERT_PATH)
};

// Initialize WalletManager
const walletManager = new WalletManager('koynlabs-2f749', '.config/firebaseServiceAccountKey.json');

// Initialize MarketMakerManager
const marketMakerManager = new MarketMakerManager('./marketMaker', './instances');

// Initialize InstanceInitializer
const instanceInitializer = new InstanceInitializer('./marketMaker', './instances');

// Middleware
app.use(bodyParser.json());

// Secret key (store this securely, e.g., in environment variables)
const SECRET_KEY = process.env.SECRET_KEY;

// Function to generate the hash
function generateHash(chatId, boostType, timestamp) {
    const data = `${chatId}:${boostType}:${timestamp}:${SECRET_KEY}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

// BullMQ queue
const walletQueue = new Queue('walletQueue', {
    connection: {
        host: 'localhost',
        port: 6379
    }
});

// Endpoint to handle incoming POST requests
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

// Worker to process wallet creation
const walletWorker = new Worker('walletQueue', async job => {
    const { chatId, boostType, count, contractAddress } = job.data;

    try {
        const wallets = walletManager.createSolanaWallets(count);
        await walletManager.saveWallets(chatId, boostType, wallets);
        await instanceInitializer.initializeMarketMakerInstance(chatId, boostType, count, contractAddress);
        console.log(`Processed job for chatId: ${chatId}`);
    } catch (error) {
        console.error('Error processing job:', error);
    }
}, {
    connection: {
        host: 'localhost',
        port: 6379
    }
});

const server = https.createServer(options, app);
server.setTimeout(10 * 60 * 1000); // Set timeout to 10 minutes
server.listen(port, () => {
    console.log(`HTTPS server is running on port ${port}`);
});