require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const admin = require('firebase-admin');
const WalletManager = require('./walletManager'); // Import the WalletManager class
const MarketMakerManager = require('./marketMakerManager'); // Import the MarketMakerManager class
const InstanceInitializer = require('./instanceInitializer'); // Import the InstanceInitializer class

admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: ""
});

const app = express();
const port = process.env.PORT || 443; // Use port 443 for HTTPS

// SSL options
const options = {
    key: fs.readFileSync('/etc/letsencrypt/live/bot.koynlabs.com/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/bot.koynlabs.com/fullchain.pem')
};

// Initialize WalletManager
const walletManager = new WalletManager('koynlabs-2f749', '.config/firebaseServiceAccountKey.json');

// Initialize MarketMakerManager
const marketMakerManager = new MarketMakerManager('../marketMaker', '../instances');

// Initialize InstanceInitializer
const instanceInitializer = new InstanceInitializer('../marketMaker', '../instances');

// Middleware
app.use(bodyParser.json());

// Secret key (store this securely, e.g., in environment variables)
const SECRET_KEY = process.env.SECRET_KEY;

// Function to generate the hash
function generateHash(chatId, boostType, timestamp) {
    const data = `${chatId}:${boostType}:${timestamp}:${SECRET_KEY}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

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

    // Proceed with processing the request
    try {
        // Create Solana wallets and encrypt private keys
        const wallets = walletManager.createSolanaWallets(count);

        // Save to Firestore
        await walletManager.saveWallets(chatId, boostType, wallets);

        // Initialize the market maker instance
        await instanceInitializer.initializeMarketMakerInstance(chatId, boostType, count);

        res.status(200).send(`Created and saved ${count} wallets successfully and set up market maker bot`);
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Start the HTTPS server
https.createServer(options, app).listen(port, () => {
    console.log(`HTTPS server is running on port ${port}`);
});