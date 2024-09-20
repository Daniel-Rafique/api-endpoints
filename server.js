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
const InstanceStart = require('./InstanceManager/start')
const InstanceStop = require('./InstanceManager/stop')


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

    const contractAddress = userData.contractAddress;
    const minimumSolBalance = userData.boostCost;
    const minimumTokenBalance = userData.tokenDetails.tokenAmount;
    const platform = userData.platform;

    if (userData.boostType === 'ultra_boost') {
      const contractAddress = userData.contractAddress;
    } else {
      const tokenMintAddress = process.env.TOKEN_MINT_ADDRESS;
    }

    // Start the periodic check
    let receiverPrivateKey = userData.walletPk;
    receiverPrivateKey = receiverPrivateKey.toString();

    if (typeof receiverPrivateKey !== 'string') {
      throw new TypeError('Receiver private key must be a string');
    }
    const websocket = new BalanceChecker(
      chatId,
      receiverPrivateKey,
      minimumSolBalance,
      minimumTokenBalance,
      telegramToken,
      contractAddress,
      platform
    );

    if (!userData?.distributeSolana) {
      websocket.initialize();
      if (platform === 'telegram') {
        telegramNotifier.sendTelegramMessage(chatId, `🔍 Waiting for ${minimumSolBalance} SOL to be confirmed...`);
      }
      res.status(200).send('Checking balance...');
    }
  } catch (error) {
    console.error('Error processing request:', error);
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  }
});

// Start the bot
app.post('/api/start', async (req, res) => {
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
  // ... in your route handler ...
  const startInstance = new InstanceStart(chatId);
  return startInstance.startInstance(chatId);
});

// Stop the bot
app.post('/api/stop', async (req, res) => {
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
  console.log('stopping instance', chatId)

  // ... in your route handler ...
  const stopInstance = new InstanceStop(chatId);
  return stopInstance.stopInstance(chatId);

});

app.post('/api/balance', async (req, res) => {
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
});

app.post('/api/liquidate', async (req, res) => {
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
});

app.post('/api/top-up', async (req, res) => {
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
});

// Create HTTPS server
const server = https.createServer(options, app);
server.setTimeout(10 * 60 * 1000); // Set timeout to 10 minutes
server.listen(port, () => {
  console.log(`HTTPS server is running on port ${port}`);
});
