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
const DiscordNotifier = require('./Discord');
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

// Initialize DiscordNotifier
const discordToken = process.env.DISCORD_TOKEN;
const discordNotifier = new DiscordNotifier(discordToken);

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

    const mintAddress = userData.contractAddress;
    const minimumSolBalance = userData.boostCost;
    const minimumTokenBalance = userData.tokenDetails.tokenAmount;
    const platform = userData.platform;

    let receiverPrivateKey = userData.userKeypair.privateKey;
    receiverPrivateKey = receiverPrivateKey.toString();

    if (typeof receiverPrivateKey !== 'string') {
      throw new TypeError('Receiver private key must be a string');
    }

    // Start the periodic check
    const balance = new BalanceChecker(
      chatId,
      receiverPrivateKey,
      minimumSolBalance,
      minimumTokenBalance,
      telegramToken,
      mintAddress,
      platform
    );

    if (!userData?.distributeSolana) {
      balance.getBalance();

      // Send platform-specific notifications
      if (platform === 'telegram') {
        await telegramNotifier.sendTelegramMessage(
          chatId,
          `🤖 *Market Maker Mode Activated*\n` +
          `🎯 Token: ${userData.tokenDetails.symbol || 'Unknown'}\n` +
          `💰 Required Balance: ${minimumSolBalance} SOL\n` +
          `🔍 Status: Waiting for confirmation...`
        );
      } else if (platform === 'discord') {
        try {
          // Check if we have valid Discord credentials
          if (!userData.applicationId || !userData.interactionToken) {
            console.error('Missing Discord interaction details for user:', chatId);
            return res.status(400).send('Missing Discord interaction details');
          }

          await discordNotifier.sendDiscordMessage(
            userData.applicationId,
            userData.interactionToken,
            `🔐 **Your Wallet Details**\n\n` +
            `**Public Key (Your Deposit Address):**\n` +
            `\`${userData.userKeypair.publicKey.toString()}\`\n\n` +
            `⚠️ **IMPORTANT:**\n` +
            `Your private key is sensitive. Click the button below to reveal it.\n\n` +
            `💡 **Next Steps:**\n` +
            `1. Save your wallet details securely\n` +
            `2. Make your minimum deposit to the public key address above\n` +
            `3. Once confirmed, your bot will start automatically\n\n` +
            `Need help? Contact @koynlabs`
          );

          // Check if this is market maker mode
          if (userData.mode === 'market_maker' ||
            userData.mode === 'catalyst' ||
            userData.mode === 'compound' ||
            userData.mode === 'velocity') {
            await discordNotifier.sendDiscordMessage(
              userData.applicationId,
              userData.interactionToken,
              `🤖 **Market Maker Mode Activated**\n` +
              `🎯 Token: ${userData.tokenDetails.symbol || 'Unknown'}\n` +
              `💰 Required Balance: ${minimumSolBalance} SOL\n` +
              `🔍 Status: Waiting for confirmation...`
            );
          } else {
            await discordNotifier.sendDiscordMessage(
              userData.applicationId,
              userData.interactionToken,
              `🔍 Waiting for ${minimumSolBalance} SOL to be confirmed...`
            );
          }
        } catch (discordError) {
          console.error('Discord notification error:', discordError);
          // Continue execution even if Discord notification fails
          res.status(200).send('🔍 Checking balance...');
        }
      }
      res.status(200).send('🔍 Checking balance...');
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

  try {
    const startInstance = new InstanceStart(chatId);
    console.log('Endpoint for start instance', chatId);
    await startInstance.startInstance(chatId);
    res.status(200).send('Instance started successfully');
  } catch (error) {
    console.error('Error starting instance:', error);
    res.status(500).send('Internal Server Error');
  }
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
