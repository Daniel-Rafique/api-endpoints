const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const pm2 = require('pm2');
const EventEmitter = require('events');
const dataManager = require('../database');
const { Firestore } = require('@google-cloud/firestore');
const WalletProcessor = require('../WalletProcessor');
const Commission = require('../Solana/Commission');
const Distribute = require('../Solana/Distribute');
const TopUp = require('../Solana/TopUp');
const TradeStrategy = require('../TradeStrategy');
const FIRESTORE_KEYSTORE = process.env.FIRESTORE_KEYSTORE;
const ENV_PATH = process.env.ENV_PATH;

// Create a dedicated event emitter for processing steps
class ProcessStepEmitter extends EventEmitter {}
const processEvents = new ProcessStepEmitter();

class InstanceManager {
  constructor(chatId) {
    // ENV_PATH=/root/marketMaker/
    this.basePath = path.resolve(os.homedir(), ENV_PATH);
    // Path to the specific sol_spl template we want to use
    this.templatePath = path.resolve(os.homedir(), ENV_PATH, 'instances', 'sol_spl');
    // Path where user instances will be created
    this.instancePath = path.resolve(os.homedir(), ENV_PATH, 'instances', 'user');
    // Path to the template env file  
    this.envTemplatePath = path.resolve(os.homedir(), ENV_PATH, '.env.template');
    this.dataManager = dataManager;
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: path.join(os.homedir(), FIRESTORE_KEYSTORE, '.config/firebaseServiceAccountKey.json'),
    });

    this.walletProcessor = new WalletProcessor(chatId, processEvents);
    this.distributeSolana = new Distribute(chatId);
    this.commissionPaid = new Commission(chatId);
    this.topUp = new TopUp(chatId);
    this.tradeStrategy = new TradeStrategy();
  }

  async initializeMarketMakerInstance(chatId, interaction) {
    try {
      console.log('Initializing SOL/SPL market maker instance:', chatId);

      const userDir = path.join(this.instancePath, chatId.toString());
      const chatIdStr = chatId.toString();

      // Step 1: Create the user directory if it doesn't exist
      if (!fs.existsSync(userDir)) {
        console.log(`Creating user directory at ${userDir}`);
        fs.mkdirSync(userDir, { recursive: true });
      }

      // Step 2: Create .config directory if it doesn't exist
      const configDir = path.join(userDir, '.config');
      if (!fs.existsSync(configDir)) {
        console.log(`Creating .config directory at ${configDir}`);
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Get user data
      let userData = await this.dataManager.getCollection(chatId);

      const steps = [
        "CHECK_INSTANCES_CREATED",
        "CHECK_WALLETS_CREATED",
        "CHECK_COMMISSION_PAID",
        "CHECK_SOLANA_DISTRIBUTION",
        "CHECK_INSTANCES_STARTED",
        "CHECK_TOPUP_STATE"
      ];

      for (const step of steps) {
        console.log(`Processing step: ${step}`);

        // Fetch fresh user data before each step
        userData = await this.dataManager.getCollection(chatId);
        if (!userData) {
          throw new Error("userData is undefined. Stopping initialization.");
        }

        try {
          switch (step) {
            case "CHECK_INSTANCES_CREATED":
              if (!userData.instancesCreated) {
                console.log('Instances not created. Creating lightweight sol_spl instance...');
                await this.createLightweightSolSplInstance(userDir, chatId, userData);
                await this.dataManager.updateCollection(chatIdStr, { instancesCreated: true });
                console.log('Lightweight sol_spl instance created.');
              } else {
                console.log('Instances already created.');
              }
              break;

            case "CHECK_WALLETS_CREATED":
              if (!userData.walletsCreated) {
                console.log('Wallets not created. Creating wallets...');
                await this.processCreateWallets(chatId, userData, userDir);
                await this.dataManager.updateCollection(chatIdStr, { walletsCreated: true });
                console.log('Wallets created and database updated.');
              } else {
                console.log('Wallets already created.');
              }
              break;

            case "CHECK_COMMISSION_PAID":
              // Force commission check by reading the flag directly
              const commissionPaidFlag = userData.commissionPaid === true;
              if (!commissionPaidFlag) {
                console.log('Commission not paid. Sending commission...');
                const signature = await this.commissionPaid.sendToCommissionWallet(chatId, userData, interaction);
                if (signature) {
                await this.dataManager.updateCollection(chatIdStr, { commissionPaid: true });
                  console.log('Commission sent successfully with signature:', signature);
                } else {
                  throw new Error('Commission transaction failed - no signature returned');
                }
              } else {
                console.log('Commission already paid.');
              }
              break;

            case "CHECK_SOLANA_DISTRIBUTION":
              // Force distribution check by reading the flag directly
              const distributionFlag = userData.distributeSolana === true;
              if (!distributionFlag) {
                console.log('Distributing Solana...');
                const result = await this.distributeSolana.distributeSolana(chatId, userData, interaction);
                if (result === true) {
                await this.dataManager.updateCollection(chatIdStr, { distributeSolana: true });
                console.log('Solana distributed successfully.');
                } else {
                  throw new Error('SOL distribution failed');
                }
              } else {
                console.log('Solana already distributed.');
              }
              break;

            case "CHECK_INSTANCES_STARTED":
              if (!userData.instancesStarted) {
                console.log('Starting market maker instance...');
                // Uncomment this line to actually start the instance
                await this.startMarketMakerInstance(chatId, userDir);
                await this.dataManager.updateCollection(chatIdStr, { instancesStarted: true });
                console.log('Market maker instance started successfully.');
              } else {
                console.log('Market maker instance already started.');
              }
              break;

            case "CHECK_TOPUP_STATE":
              if (userData.topUpState) {
                console.log('Distributing topup...');
                await this.topUp.handleCommission(chatId, userData);
                await this.dataManager.updateCollection(chatIdStr, { topUpState: false });
                console.log('Market makers topped up.');
              } else {
                console.log('Market maker already topped up.');
              }
              break;

            default:
              console.error('Unknown step:', step);
          }
        } catch (stepError) {
          console.error(`Error in step ${step}:`, stepError);
          await this.dataManager.updateCollection(chatIdStr, { lastError: `Error in ${step}: ${stepError.message}` });
          throw stepError;
        }
      }

      console.log('SOL/SPL market maker instance initialization completed successfully.');

    } catch (error) {
      console.error('Error initializing market maker instance:', error);
      throw error;
    }
  }

  // New method to handle wallet creation with event emitter
  async processCreateWallets(chatId, userData, userDir) {
    return new Promise((resolve, reject) => {
      const walletFilePath = path.join(userDir, '.config', 'wallets.json');
      
      // First check if wallets already exist
      if (fs.existsSync(walletFilePath)) {
        try {
          const walletsData = JSON.parse(fs.readFileSync(walletFilePath, 'utf8'));
          if (Array.isArray(walletsData) && walletsData.length > 0) {
            console.log(`Found existing wallet file with ${walletsData.length} wallets`);
            return resolve();
          }
        } catch (err) {
          console.log('Error reading existing wallet file, will create new wallets');
        }
      }
      
      // Set up event listeners for wallet creation process
      const walletCreatedHandler = (data) => {
        if (data && data.chatId === chatId) {
          console.log(`Received walletCreated event for chatId: ${chatId}`);
          processEvents.removeListener('walletCreated', walletCreatedHandler);
          processEvents.removeListener('walletError', walletErrorHandler);
          clearTimeout(timeout);
          resolve();
        }
      };

      const walletErrorHandler = (data) => {
        if (data && data.chatId === chatId) {
          console.error(`Received walletError event for chatId: ${chatId}:`, data.error);
          processEvents.removeListener('walletCreated', walletCreatedHandler);
          processEvents.removeListener('walletError', walletErrorHandler);
          clearTimeout(timeout);
          
          // Check if wallets were created despite the error
          if (fs.existsSync(walletFilePath)) {
            try {
              const walletsData = JSON.parse(fs.readFileSync(walletFilePath, 'utf8'));
              if (Array.isArray(walletsData) && walletsData.length > 0) {
                console.log(`Despite error, wallet file exists with ${walletsData.length} wallets`);
                resolve();
                return;
              }
            } catch (err) {
              // File exists but is invalid, proceed with reject
            }
          }
          
          reject(new Error(`Wallet creation failed: ${data.error}`));
        }
      };
      
      // Set up a file watcher as fallback
      const startFileWatcher = () => {
        console.log(`Starting file watcher for ${walletFilePath}`);
        const checkWalletFile = () => {
          if (fs.existsSync(walletFilePath)) {
            try {
              const walletsData = JSON.parse(fs.readFileSync(walletFilePath, 'utf8'));
              if (Array.isArray(walletsData) && walletsData.length > 0) {
                console.log(`File watcher detected wallet file with ${walletsData.length} wallets`);
                clearInterval(fileWatcherInterval);
                processEvents.removeListener('walletCreated', walletCreatedHandler);
                processEvents.removeListener('walletError', walletErrorHandler);
                clearTimeout(timeout);
                resolve();
              }
            } catch (err) {
              console.log('File exists but invalid, continuing to watch');
            }
          }
        };
        
        const fileWatcherInterval = setInterval(checkWalletFile, 5000);
        return fileWatcherInterval;
      };
      
      // Set a timeout
      const timeout = setTimeout(() => {
        console.log(`Timeout reached for wallet creation for chatId: ${chatId}`);
        processEvents.removeListener('walletCreated', walletCreatedHandler);
        processEvents.removeListener('walletError', walletErrorHandler);
        
        // Final check for wallet file
        if (fs.existsSync(walletFilePath)) {
          try {
            const walletsData = JSON.parse(fs.readFileSync(walletFilePath, 'utf8'));
            if (Array.isArray(walletsData) && walletsData.length > 0) {
              console.log(`Timeout reached but wallet file exists with ${walletsData.length} wallets`);
              resolve();
              return;
            }
          } catch (err) {
            // File exists but is invalid
          }
        }
        
        reject(new Error(`Wallet creation timed out after ${300000}ms`));
      }, 300000);
      
      // Set up listeners
      processEvents.on('walletCreated', walletCreatedHandler);
      processEvents.on('walletError', walletErrorHandler);
      
      // Start the wallet creation process
      console.log(`Initiating wallet creation for chatId: ${chatId}`);
      this.walletProcessor.createWallets(chatId, userData)
        .catch(error => {
          console.error(`Error initiating wallet creation: ${error.message}`);
          // The error will be handled by the walletErrorHandler
        });
    });
  }

  async createLightweightSolSplInstance(userDir, chatId, userData) {
    try {
      console.log(`Creating lightweight sol_spl instance in ${userDir}`);
      
      // 1. Create the symlinks for shared code (like in copyInstance.sh)
      const mainDir = path.resolve(os.homedir(), ENV_PATH);
      
      // Define symlink paths
      const nodeModulesLink = path.join(userDir, 'node_modules');
      const distLink = path.join(userDir, 'dist');
      
      // Remove existing symlinks or directories if they exist
      this.safeRemove(nodeModulesLink);
      this.safeRemove(distLink);
      
      // Create symlinks
      console.log(`Creating symlink: ${mainDir}/node_modules -> ${nodeModulesLink}`);
      fs.symlinkSync(path.join(mainDir, 'node_modules'), nodeModulesLink, 'junction');
      
      console.log(`Creating symlink: ${mainDir}/dist -> ${distLink}`);
      fs.symlinkSync(path.join(mainDir, 'dist'), distLink, 'junction');
      
      console.log('Created symlinks for node_modules and dist');
      
      // 2. Copy the .env.template file (like in copyInstance.sh)
      const envTemplatePath = path.join(mainDir, '.env.template');
      const destEnvPath = path.join(userDir, '.env');

      if (fs.existsSync(envTemplatePath)) {
        fs.copyFileSync(envTemplatePath, destEnvPath);
        console.log(`Copied .env.template to ${destEnvPath}`);
      } else {
        console.error('Could not find .env.template');
        return false;
      }
      
      // 3. Update the .env file with user-specific values
      let envContent = fs.readFileSync(destEnvPath, 'utf8');
      
      // Replace TRADE_TYPE in the .env file
      envContent = envContent.replace(/^TRADE_TYPE=.*$/m, 'TRADE_TYPE=sol_spl');
      
      // Calculate trading parameters using TradeStrategy if available
      console.log('Calculating trading parameters using TradeStrategy...');
      let buyAmount, sellAmount, takeProfit, stopLoss, dcaAmount;
      
      try {
        // Calculate dynamic values from TradeStrategy
        buyAmount = this.tradeStrategy.calculateBuyAmount(userData);
        sellAmount = this.tradeStrategy.calculateSellAmount(userData);
        takeProfit = this.tradeStrategy.calculateTakeProfit(userData);
        stopLoss = this.tradeStrategy.calculateStopLoss(userData);
        dcaAmount = this.tradeStrategy.calculateDCAAmount(userData);
        
        console.log(`Calculated parameters: buyAmount=${buyAmount}, sellAmount=${sellAmount}, takeProfit=${takeProfit}, stopLoss=${stopLoss}, dcaAmount=${dcaAmount}`);
      } catch (calcError) {
        console.error('Error calculating trading parameters:', calcError);
        // Fall back to default values
        buyAmount = userData.buyAmount || 0.05;
        sellAmount = userData.sellAmount || 100;
        takeProfit = userData.profitMargin || 50;
        stopLoss = userData.stopLoss || 50;
        dcaAmount = userData.dcaAmount || 0.025;
        console.log(`Using fallback parameters: buyAmount=${buyAmount}, sellAmount=${sellAmount}, takeProfit=${takeProfit}, stopLoss=${stopLoss}, dcaAmount=${dcaAmount}`);
      }
      
      // Add market maker specific settings
      const additionalConfig = `
# Market maker specific settings
CHAT_ID=${chatId}
CONTRACT_ADDRESS=${userData.contractAddress}
TOKEN_DECIMALS=${userData.tokenDecimals || 6}
TOKEN_SYMBOL=${userData.tokenSymbol}
BATCH_SIZE=${userData.batchSize || 1}
BOOST_TYPE=${userData.boostType || 'none'}
BUY_AMOUNT=${buyAmount}
SELL_AMOUNT=${sellAmount}
TAKE_PROFIT=${takeProfit}
STOP_LOSS=${stopLoss}
DCA_AMOUNT=${dcaAmount}
SENDER_WALLET=${userData.address}
AMOUNT_PER_WALLET=${userData.amountPerWallet || 0.05}
SIGNAL_ONLY=false
ENV_PATH=${ENV_PATH}

# Dummy values for services not needed in market maker instances
DISCORD_TOKEN=dummy_token
DISCORD_CHANNELS=dummy_channel
TELEGRAM_TOKEN=dummy_token
TELEGRAM_CHAT_ID=${chatId}
DISCORD_BOT_TOKEN=dummy_token
DISCORD_CHANNEL_ID=dummy_channel
MM_MODE=true
`;
      
      // Write the updated content back to the file
      fs.writeFileSync(destEnvPath, envContent + additionalConfig);
      console.log('Updated .env file with market maker configuration');
      
      return true;
    } catch (error) {
      console.error('Error creating lightweight sol_spl instance:', error);
      return false;
    }
  }

  // Helper method to safely remove a file or directory
  safeRemove(path) {
    try {
      if (fs.existsSync(path)) {
        const stats = fs.lstatSync(path);
        
        if (stats.isSymbolicLink()) {
          // If it's a symlink, just unlink it
          console.log(`Removing existing symlink: ${path}`);
          fs.unlinkSync(path);
        } else if (stats.isDirectory()) {
          // If it's a directory, remove it recursively
          console.log(`Removing existing directory: ${path}`);
          fs.rmSync(path, { recursive: true, force: true });
    } else {
          // If it's a regular file
          console.log(`Removing existing file: ${path}`);
          fs.unlinkSync(path);
        }
      }
    } catch (error) {
      console.error(`Error removing ${path}:`, error);
      // Continue despite errors
    }
  }

  async startMarketMakerInstance(chatId, userDir) {
    const instanceName = `market-maker-${chatId}`;
    console.log(`Starting sol_spl market maker instance ${instanceName}...`);

    return new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) {
          console.error('Failed to connect to PM2:', err);
          reject(new Error('Failed to connect to PM2'));
          return;
        }

        pm2.start({
          script: path.join(userDir, 'dist', 'index.js'),
          name: instanceName,
          cwd: userDir,
          env: {
            NODE_ENV: 'production',
            CHAT_ID: chatId,
            TRADE_TYPE: 'sol_spl'
          },
          watch: ['dist'],
          ignore_watch: ['node_modules', '*.log'],
          autorestart: true,
          max_memory_restart: '1G'
        }, async (err) => {
          if (err) {
            console.error(`Failed to start market maker instance ${instanceName}:`, err);
            pm2.disconnect();
            reject(err);
            return;
          }

          try {
            await this.runCommand('pm2 save');
            await this.runCommand('pm2 startup');
            console.log(`Market maker instance ${instanceName} started and saved successfully`);
            resolve(true);
          } catch (error) {
            console.error('Failed to save PM2 configuration:', error);
            reject(error);
          } finally {
            pm2.disconnect();
          }
        });
      });
    });
  }

  runCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(`Error: ${stderr}`);
        } else {
          resolve(stdout);
        }
      });
    });
  }

  patchIndexFile(content) {
    // Wrap the Discord and Telegram initializations in try-catch blocks
    return content.replace(
        "const discord = new DiscordService();",
        `// Safe initialization of services
let discord;
try {
    discord = new DiscordService();
} catch (err) {
    console.log('Discord service initialization failed, using dummy service');
    discord = {
        sendMessage: () => Promise.resolve(true)
    };
}`
    ).replace(
        "const telegram = new TelegramService();",
        `let telegram;
try {
    telegram = new TelegramService();
} catch (err) {
    console.log('Telegram service initialization failed, using dummy service');
    telegram = {
        sendMessage: () => Promise.resolve(true)
    };
}`
    ).replace(
        "await client.connect();",
        `try {
    await client.connect();
    console.log('Connected to Redis');
} catch (err) {
    console.log('Redis connection failed in market maker mode, continuing without Redis');
}`
    );
  }
}

module.exports = InstanceManager;
