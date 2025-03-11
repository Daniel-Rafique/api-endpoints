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
const dataManager = require('./database'); // This now imports the singleton instance
const BalanceChecker = require('./BalanceChecker');
const InstanceStart = require('./InstanceManager/start')
const InstanceStop = require('./InstanceManager/stop')
const axios = require('axios');
const xml2js = require('xml2js');

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
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

// Function to generate the hash
function generateHash(chatId, timestamp) {
  const data = `${chatId}:${timestamp}:${ENCRYPTION_KEY}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Endpoint to handle incoming POST requests
app.post('/api/create', async (req, res) => {
  try {
    let { chatId, timestamp, interaction, hash } = req.body;

    console.log('Received request:', {
      chatId,
      timestamp,
      interaction: interaction ? 'present' : 'null',
      hash
    });

    // Validate parameters
    if (!chatId || !hash) {
      console.log('Missing required parameters');
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Validate the hash
    const expectedHash = generateHash(chatId, timestamp);
    if (hash !== expectedHash) {
      console.log(`Hash mismatch! Expected: ${expectedHash}, Received: ${hash}`);
      return res.status(403).json({ error: 'Invalid request signature' });
    }

    try {
      const userData = await dataManager.getCollection(chatId.toString());
      if (!userData) {
        console.log('User data not found for chatId:', chatId);
        return res.status(404).json({ error: 'User data not found' });
      }

      const mintAddress = userData.contractAddress;
      const minimumSolBalance = 0.025;
      const minimumTokenBalance = userData.tokenDetails.tokenAmount;
      const platform = userData.platform;

      let receiverPrivateKey = userData.userKeypair.secretKey;
      receiverPrivateKey = receiverPrivateKey.toString();

      if (typeof receiverPrivateKey !== 'string') {
        console.error('Invalid private key type:', typeof receiverPrivateKey);
        throw new TypeError('Receiver private key must be a string');
      }

      // Start the periodic check
      let balance = new BalanceChecker(
        chatId,
        receiverPrivateKey,
        minimumSolBalance,
        minimumTokenBalance,
        mintAddress,
        platform,
        interaction,
        userData
      );

      if (!userData?.distributeSolana) {
        try {
          await balance.getBalance(interaction);
          res.status(200).json({
            message: '🔍 Initializing trading wallets...',
            details: {
              wallets: userData.makers,
              solPerWallet: userData.solPerWallet,
              mode: userData.boostName
            }
          });
        } catch (balanceError) {
          // Just log the error and cleanup without sending additional messages
          console.log('Balance check failed:', balanceError);
          balance.cleanup();
          return res.status(500).json({
            error: 'Balance check failed',
          });
        }
      }
    } catch (dbError) {
      console.error('Database error:', dbError);
      return res.status(500).json({
        error: 'Internal server error',
      });
    }

  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

// Use dataManager directly
app.post('/api/mode', async (req, res) => {
  try {
    const { chatId, mode } = req.body;
    await dataManager.setMode(chatId, mode);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
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

// let timestamp = Date.now();
// let hash = generateHash(profileId, timestamp);
// function generateHash(chatId, timestamp,) {
//   const data = `${chatId}:${timestamp}:${SECRET_KEY}`;
//   return crypto.createHash('sha256').update(data).digest('hex');
// }
// npm install axios xml2js

function stripHtmlAndDecodeEntities(html) {
  if (!html) return '';
  
  // First decode HTML entities
  let decoded = html.replace(/&lt;/g, '<')
                   .replace(/&gt;/g, '>')
                   .replace(/&amp;/g, '&')
                   .replace(/&quot;/g, '"')
                   .replace(/&#39;/g, "'")
                   .replace(/\[\[CDATA\[(.*?)\]\]>/g, '$1');
  
  // Then strip HTML tags
  return decoded.replace(/<[^>]*>/g, '')
               .replace(/\s+/g, ' ')
               .trim();
}
app.post('/api/profiles', async (req, res) => {
  const { profileId, timestamp, hash } = req.body;

  // Validate parameters
  if (!profileId) {
    return res.status(400).json({ 
      status: {
        code: 400,
        message: 'Missing profileId parameter'
      },
      data: null
    });
  }

  try {
    // Fetch RSS feed with profileId
    const response = await axios.get(`https://koynlabs.com/${profileId}/rss`);
    const parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true
    });

    // Parse XML to JSON
    const result = await parser.parseStringPromise(response.data);
    
    // Transform the data structure and strip HTML
    const responseData = {
      status: {
        code: response.status,
        message: 'Success',
        timestamp: new Date().toISOString()
      },
      data: {
        metadata: {
          title: stripHtmlAndDecodeEntities(result.rss.channel.title),
          link: result.rss.channel.link,
          description: stripHtmlAndDecodeEntities(result.rss.channel.description),
          language: result.rss.channel.language,
          image: result.rss.channel.image
        },
        items: result.rss.channel.item.map(item => ({
          title: stripHtmlAndDecodeEntities(item.title),
          creator: stripHtmlAndDecodeEntities(item['dc:creator']),
          description: stripHtmlAndDecodeEntities(item.description),
          pubDate: item.pubDate,
          guid: item.guid,
          link: item.link
        }))
      }
    };

    res.json(responseData);
  } catch (error) {
    console.error('Error fetching or parsing RSS feed:', error);
    res.status(500).json({ 
      status: {
        code: error.response?.status || 500,
        message: 'Failed to fetch or parse RSS feed',
        error: error.message,
        timestamp: new Date().toISOString()
      },
      data: null
    });
  }
});

app.post('/api/search', async (req, res) => {
  const { query, timestamp, hash } = req.body;

  // Validate parameters
  if (!query) {
    return res.status(400).json({ 
      status: {
        code: 400,
        message: 'Missing search query parameter'
      },
      data: null
    });
  }

  try {
    // Fetch RSS feed with search query
    const response = await axios.get(`https://koynlabs.com/search/rss`, {
      params: {
        f: 'tweets',
        q: query
      }
    });
    
    const parser = new xml2js.Parser({
      explicitArray: false,
      mergeAttrs: true
    });

    // Parse XML to JSON
    const result = await parser.parseStringPromise(response.data);
    
    // Transform the data structure and strip HTML
    const responseData = {
      status: {
        code: response.status,
        message: 'Success',
        timestamp: new Date().toISOString(),
        query: query
      },
      data: {
        metadata: {
          title: stripHtmlAndDecodeEntities(result.rss.channel.title),
          link: result.rss.channel.link,
          description: stripHtmlAndDecodeEntities(result.rss.channel.description),
          language: result.rss.channel.language
        },
        items: result.rss.channel.item.map(item => ({
          title: stripHtmlAndDecodeEntities(item.title),
          creator: stripHtmlAndDecodeEntities(item['dc:creator']),
          description: stripHtmlAndDecodeEntities(item.description),
          pubDate: item.pubDate,
          guid: item.guid,
          link: item.link,
          // Extract hashtags from description and title
          hashtags: extractHashtags(item.description + ' ' + item.title)
        }))
      }
    };

    res.json(responseData);
  } catch (error) {
    console.error('Error fetching or parsing RSS feed:', error);
    res.status(500).json({ 
      status: {
        code: error.response?.status || 500,
        message: 'Failed to fetch or parse RSS feed',
        error: error.message,
        timestamp: new Date().toISOString(),
        query: query
      },
      data: null
    });
  }
});

// Helper function to extract hashtags
function extractHashtags(text) {
  if (!text) return [];
  const hashtagRegex = /#[\w\u0590-\u05ff]+/g;
  const matches = text.match(hashtagRegex);
  return matches ? [...new Set(matches)] : []; // Remove duplicates
}

// Create HTTPS server
const server = https.createServer(options, app);
server.setTimeout(10 * 60 * 1000); // Set timeout to 10 minutes
server.listen(port, () => {
  console.log(`HTTPS server is running on port ${port}`);
});

