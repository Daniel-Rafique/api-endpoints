require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const WalletManager = require('./walletManager'); // Import the WalletManager class
const MarketMakerManager = require('./marketMakerManager'); // Import the MarketMakerManager class

const app = express();
const port = process.env.PORT || 443; // Use port 443 for HTTPS

// SSL options
const options = {
    key: fs.readFileSync('/etc/letsencrypt/live/bot.koynlabs.com/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/bot.koynlabs.com/fullchain.pem')
};

// Initialize WalletManager
const walletManager = new WalletManager('koynlabs-2f749', './firebaseServiceAccountKey.json');

// Initialize MarketMakerManager
const marketMakerManager = new MarketMakerManager('marketMaker', '/instances');

app.use(bodyParser.json());

// Endpoint to handle incoming POST requests
app.post('/api/create', async (req, res) => {
    const { chatId, boostType, walletCount } = req.body;

    if (!chatId || !boostType || !walletCount || walletCount > 1000) {
        return res.status(400).send('Missing chatId, boostType, or invalid walletCount');
    }

    // Create Solana wallets and encrypt private keys
    const wallets = walletManager.createSolanaWallets(walletCount);

    // Save to Firestore
    try {
        await walletManager.saveWallets(chatId, boostType, wallets);

        // Copy market maker directory, pull latest code, install dependencies, and start with PM2
        marketMakerManager.copyMarketMakerDirectory(chatId, (error) => {
            if (error) {
                return res.status(500).send('Failed to setup market maker bot');
            }
            res.status(200).send(`Created and saved ${walletCount} wallets successfully and set up market maker bot`);
        });
    } catch (error) {
        res.status(500).send('Internal Server Error');
    }
});

// Start the HTTPS server
https.createServer(options, app).listen(port, () => {
    console.log(`HTTPS server is running on port ${port}`);
});