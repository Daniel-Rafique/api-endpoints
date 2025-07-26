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
const axios = require('axios');
const dataManager = require('./database'); // This now imports the singleton instance
const BalanceChecker = require('./BalanceChecker');

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

// Add map to store active balance checker instances
const activeBalanceCheckers = new Map();

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
      const minimumSolBalance = userData.boostCost;
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

      // Store the balance checker instance
      activeBalanceCheckers.set(chatId.toString(), balance);

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
    const { chatId, mode, timestamp, hash } = req.body;
    if (!chatId || !mode) {
      console.log('Missing required parameters');
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    const expectedHash = generateHash(chatId, timestamp);
    if (hash !== expectedHash) {
      console.log(`Hash mismatch! Expected: ${expectedHash}, Received: ${hash}`);
      return res.status(403).json({ error: 'Invalid request signature' });
    }
    await dataManager.setMode(chatId, mode);
    
    // Get the balance checker instance and cleanup
    const balance = activeBalanceCheckers.get(chatId.toString());
    if (balance) {
      balance.cleanup();
      activeBalanceCheckers.delete(chatId.toString());
    }
    
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

// License verification endpoint (proxy to Helio API)
app.post('/api/verify-license', async (req, res) => {
  try {
    const { licenseKey } = req.body;
    
    // Validate parameters
    if (!licenseKey) {
      console.log('Missing license key in verification request');
      return res.status(400).json({ error: 'License key is required' });
    }
    
    // Check if it's a master license key (for admin/testing)
    if (licenseKey.startsWith('MASTER-')) {
      console.log(`Master license key verification: ${licenseKey}`);
      return res.status(200).json({
        valid: true,
        message: 'Master license key verified',
        features: ['basic_functionality', 'volume_bot', 'comment_bot', 'master_access'],
        tier: 'master',
        expiresAt: null // Master keys don't expire
      });
    }
    
    // For regular license keys (Helio subscription IDs), proxy to Helio API
    try {
      const helioApiKey = process.env.HELIO_API_KEY;
      if (!helioApiKey) {
        console.error('HELIO_API_KEY not configured');
        return res.status(500).json({
          error: 'Server configuration error'
        });
      }
      
      // Call Helio API to check subscription status
      const helioResponse = await axios.get(`https://api.hel.io/v1/subscriptions/${licenseKey}`, {
        headers: {
          'Authorization': `Bearer ${helioApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      
      if (helioResponse.status === 200) {
        const subscription = helioResponse.data;
        
        // Check subscription status
        const isActive = subscription.status === 'active' || subscription.status === 'trialing';
        const expiresAt = subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null;
        const isExpired = expiresAt && expiresAt < new Date();
        
        if (isActive && !isExpired) {
          return res.status(200).json({
            valid: true,
            message: 'Subscription verified with Helio',
            features: ['basic_functionality', 'volume_bot', 'comment_bot'],
            tier: subscription.price_id ? 'premium' : 'basic',
            expiresAt: expiresAt ? expiresAt.toISOString() : null
          });
        } else {
          return res.status(401).json({
            valid: false,
            message: `Subscription is ${subscription.status}${isExpired ? ' (expired)' : ''}`
          });
        }
      } else {
        return res.status(401).json({
          valid: false,
          message: 'Subscription not found'
        });
      }
    } catch (helioError) {
      console.error('Helio API error:', helioError.message);
      
      // Handle specific Helio API errors
      if (helioError.response?.status === 404) {
        return res.status(401).json({
          valid: false,
          message: 'Subscription not found'
        });
      } else if (helioError.response?.status === 401) {
        return res.status(500).json({
          error: 'Invalid Helio API credentials'
        });
      } else {
        return res.status(500).json({
          error: 'Unable to verify subscription with Helio API'
        });
      }
    }
  } catch (error) {
    console.error('License verification error:', error);
    return res.status(500).json({
      error: 'Internal server error during license verification'
    });
  }
});

// Generate master license key endpoint (protected by admin token)
app.post('/api/generate-master-license', async (req, res) => {
  try {
    const { adminToken, durationMonths = 12 } = req.body;
    
    // Validate admin token (compare with environment variable)
    if (!adminToken || adminToken !== process.env.ADMIN_API_TOKEN) {
      console.log('Invalid admin token');
      return res.status(403).json({ error: 'Unauthorized access' });
    }
    
    // Generate a master license key
    const masterKey = generateMasterLicenseKey();
    
    // Calculate expiration date based on duration months
    const currentDate = new Date();
    const expirationDate = new Date(currentDate);
    expirationDate.setMonth(currentDate.getMonth() + durationMonths);
    
    // Store the master license key in a separate collection for admin reference
    try {
      const db = admin.firestore();
      await db.collection('master_licenses').add({
        licenseKey: masterKey,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        licenseDurationMonths: durationMonths,
        expiresAt: admin.firestore.Timestamp.fromDate(expirationDate),
        isAdmin: true,
        status: 'VALID'
      });
    } catch (dbError) {
      console.error('Error storing master license:', dbError);
    }
    
    return res.status(200).json({
      licenseKey: masterKey,
      duration: `${durationMonths} months`,
      expiresAt: expirationDate.toISOString(),
      message: 'Master license key generated successfully'
    });
  } catch (error) {
    console.error('Error generating master license:', error);
    return res.status(500).json({
      error: 'Internal server error during license generation'
    });
  }
});

// Generate a master license key
function generateMasterLicenseKey() {
  try {
    // Generate a more complex master key with additional entropy
    const timestamp = Date.now();
    const randomValue = crypto.randomBytes(16).toString('hex');
    
    // Create a string to hash
    const dataToHash = `MASTER-${timestamp}-${randomValue}-${ENCRYPTION_KEY}`;
    
    // Use crypto to create a SHA-256 hash and take a portion of it
    const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');
    
    // Format the license key to be user-friendly with MASTER prefix
    const formattedKey = `MASTER-${hash.substring(0, 4)}-${hash.substring(4, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}`;
    
    console.log(`Generated master license key: ${formattedKey}`);
    return formattedKey;
  } catch (error) {
    console.error('Error generating master license key:', error);
    return 'ERROR-GENERATING-MASTER-KEY';
  }
}

// Endpoint to check for expired licenses (admin only)
app.post('/api/check-expired-licenses', async (req, res) => {
  try {
    const { adminToken } = req.body;
    
    // Validate admin token
    if (!adminToken || adminToken !== process.env.ADMIN_API_TOKEN) {
      console.log('Invalid admin token for expired license check');
      return res.status(403).json({ error: 'Unauthorized access' });
    }
    
    // Run the expired license check
    const result = await dataManager.checkExpiredLicenses();
    
    return res.status(200).json({
      ...result,
      message: `License check completed. Updated ${result.updated || 0} expired licenses.`
    });
  } catch (error) {
    console.error('Error checking expired licenses:', error);
    return res.status(500).json({
      error: 'Internal server error during expired license check'
    });
  }
});

// Create HTTPS server
const server = https.createServer(options, app);
server.setTimeout(10 * 60 * 1000); // Set timeout to 10 minutes
server.listen(port, () => {
  console.log(`HTTPS server is running on port ${port}`);
  
  // Set up a scheduled task to check for expired licenses daily
  setInterval(async () => {
    try {
      console.log('Running scheduled check for expired licenses...');
      const result = await dataManager.checkExpiredLicenses();
      console.log(`Scheduled license check completed. Updated ${result.updated || 0} expired licenses.`);
    } catch (error) {
      console.error('Error in scheduled expired license check:', error);
    }
  }, 24 * 60 * 60 * 1000); // Run every 24 hours
});

