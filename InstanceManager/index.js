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
const { PublicKey } = require('@solana/web3.js');

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
    this.envTemplatePath = path.resolve(os.homedir(), ENV_PATH, '.env.example');
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

            // case "CHECK_SOLANA_DISTRIBUTION":
            //   // Force distribution check by reading the flag directly
            //   const distributionFlag = userData.distributeSolana === true;
            //   if (!distributionFlag) {
            //     console.log('Distributing Solana...');
                
            //     // First check the wallet file to get the actual number of wallets
            //     const walletFilePath = path.join(userDir, '.config', 'wallets.json');
            //     let walletCount = 0;
                
            //     try {
            //       if (fs.existsSync(walletFilePath)) {
            //         const walletsData = JSON.parse(fs.readFileSync(walletFilePath, 'utf8'));
            //         walletCount = Array.isArray(walletsData) ? walletsData.length : 0;
            //         console.log(`Found ${walletCount} wallets for distribution`);
            //       }
            //     } catch (error) {
            //       console.error('Error reading wallet file:', error);
            //     }
                
            //     // Get the sender's current balance
            //     let senderBalance = 0;
            //     try {
            //       const publicKeyObj = typeof userData.userKeypair.publicKey === 'string' 
            //         ? new PublicKey(userData.userKeypair.publicKey) 
            //         : userData.userKeypair.publicKey;
                  
            //       senderBalance = await this.distributeSolana.connection.getBalance(publicKeyObj);
            //       console.log(`Sender wallet balance: ${senderBalance / 1e9} SOL`);
            //     } catch (error) {
            //       console.error('Error getting sender balance:', error);
            //     }
                
            //     // Use TradeStrategy to calculate optimal wallet amount
            //     if (walletCount > 0) {
            //       // Enrich userData with additional context for calculation
            //       userData.walletCount = walletCount;
            //       userData.totalBalance = senderBalance;
                  
            //       // Calculate optimal amount per wallet using neural network
            //       const walletAmountResult = this.tradeStrategy.calculateWalletAmount(userData);
                  
            //       // Add to userData for the distribute method to use - override any user-defined values
            //       userData.solDistributionAmount = walletAmountResult.lamports;
            //       userData.calculatedSolAmount = walletAmountResult.solAmount;
            //       userData.amountPerWallet = walletAmountResult.solAmount; // Replace user value
                  
            //       console.log(`Using AI-calculated distribution amount: ${walletAmountResult.solAmount} SOL per wallet`);
            //     }
                
            //     // Add this after calculating walletAmountResult
            //     userData.originalAmountPerWallet = userData.amountPerWallet; // Preserve the original
                
            //     const result = await this.distributeSolana.distributeSolana(chatId, userData, interaction);
            //     if (result === true) {
            //       await this.dataManager.updateCollection(chatIdStr, { distributeSolana: true });
            //       console.log('Solana distributed successfully.');
            //     } else {
            //       throw new Error('SOL distribution failed');
            //     }
            //   } else {
            //     console.log('Solana already distributed.');
            //   }
            //   break;

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
          console.log('Error reading existing wallet file, will create new wallets:', err);
        }
      }
      
      // Set up event listeners
      const walletCreatedHandler = (data) => {
        if (data && data.chatId === chatId) {
          console.log(`Received walletCreated event for chatId: ${chatId}`);
          cleanup();
          resolve();
        }
      };

      const walletErrorHandler = (data) => {
        if (data && data.chatId === chatId) {
          console.error(`Received walletError event for chatId: ${chatId}:`, data.error);
          cleanup();
          checkWalletFileBeforeReject();
        }
      };
      
      // Helper to clean up all listeners and timeouts
      const cleanup = () => {
        processEvents.removeListener('walletCreated', walletCreatedHandler);
        processEvents.removeListener('walletError', walletErrorHandler);
        if (fileWatcherInterval) clearInterval(fileWatcherInterval);
        if (timeout) clearTimeout(timeout);
      };
      
      // Check wallet file as last resort before rejecting
      const checkWalletFileBeforeReject = () => {
        if (fs.existsSync(walletFilePath)) {
          try {
            const walletsData = JSON.parse(fs.readFileSync(walletFilePath, 'utf8'));
            if (Array.isArray(walletsData) && walletsData.length > 0) {
              console.log(`Despite error, wallet file exists with ${walletsData.length} wallets`);
              resolve();
              return true;
            }
          } catch (err) {
            // File exists but is invalid
          }
        }
        reject(new Error(`Wallet creation failed`));
        return false;
      };
      
      // Start the file watcher now (it was defined but never used in your code)
      let fileWatcherInterval;
      const startFileWatcher = () => {
        console.log(`Starting file watcher for ${walletFilePath}`);
        fileWatcherInterval = setInterval(() => {
          if (fs.existsSync(walletFilePath)) {
            try {
              const walletsData = JSON.parse(fs.readFileSync(walletFilePath, 'utf8'));
              if (Array.isArray(walletsData) && walletsData.length > 0) {
                console.log(`File watcher detected wallet file with ${walletsData.length} wallets`);
                cleanup();
                resolve();
              }
            } catch (err) {
              console.log('File exists but invalid, continuing to watch');
            }
          }
        }, 5000);
      };
      
      // Start the file watcher
      startFileWatcher();
      
      // Set a timeout
      const timeout = setTimeout(() => {
        console.log(`Timeout reached for wallet creation for chatId: ${chatId}`);
        cleanup();
        checkWalletFileBeforeReject();
      }, 300000); // 5 minutes
      
      // Set up listeners
      processEvents.on('walletCreated', walletCreatedHandler);
      processEvents.on('walletError', walletErrorHandler);
      
      // Start the wallet creation process
      console.log(`Initiating wallet creation for chatId: ${chatId}`);
      this.walletProcessor.createWallets(chatId, userData)
        .catch(error => {
          console.error(`Error initiating wallet creation: ${error.message}`);
          // Error will be handled by walletErrorHandler
        });
    });
  }

  // Add a method to patch and copy the index.js file
  async patchAndCopyIndexFile(userDir, mainDir) {
    try {
      const sourceIndexPath = path.join(mainDir, 'dist', 'index.js');
      const destIndexPath = path.join(userDir, 'dist', 'index.js');
      
      // Create dist directory if it doesn't exist (it should already exist from symlink)
      if (!fs.existsSync(path.dirname(destIndexPath))) {
        fs.mkdirSync(path.dirname(destIndexPath), { recursive: true });
      }
      
      // Read the source file
      let indexContent = fs.readFileSync(sourceIndexPath, 'utf8');
      
      // Patch the wallet file path to use process.cwd() instead of __dirname
      indexContent = indexContent.replace(
        /this\.walletFilePath = path\.resolve\(__dirname, '\.\.\/\.config\/wallets\.json'\);/,
        `this.walletFilePath = path.resolve(process.cwd(), '.config/wallets.json');`
      );
      
      // Write the patched file directly to the instance's dist directory
      // This will override the symlinked index.js
      fs.writeFileSync(destIndexPath, indexContent);
      console.log(`Patched and copied index.js to ${destIndexPath}`);
      
      return true;
    } catch (error) {
      console.error('Error patching index.js:', error);
      return false;
    }
  }

  async createLightweightSolSplInstance(userDir, chatId, userData) {
    try {
      console.log(`Creating lightweight sol_spl instance in ${userDir}`);
      
      // Ensure base directory exists
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }
      
      // Ensure .config directory exists
      const configDir = path.join(userDir, '.config');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      // 1. Get paths to main installation
      const mainDir = path.resolve(os.homedir(), ENV_PATH);
      
      // 2. Create symlinks for shared code (including dist)
      const nodesToSymlink = ['node_modules', 'dist'];
      
      for (const node of nodesToSymlink) {
        const targetPath = path.join(mainDir, node);
        const linkPath = path.join(userDir, node);
        
        // Check if target exists before creating symlink
        if (!fs.existsSync(targetPath)) {
          console.warn(`Warning: Target for symlink does not exist: ${targetPath}`);
          continue;
        }
        
        // Remove existing symlink/directory/file if it exists
        this.safeRemove(linkPath);
        
        // Create new symlink with proper logging
        console.log(`Creating symlink: ${targetPath} -> ${linkPath}`);
        fs.symlinkSync(targetPath, linkPath, 'junction');
      }
      
      // 3. Patch index.js file after creating the symlink
      // This keeps the symlink to dist/ but replaces just the index.js file
      await this.patchAndCopyIndexFile(userDir, mainDir);
      
      // 4. Copy and update .env file
      const envTemplatePath = path.join(mainDir, '.env.example');
      const destEnvPath = path.join(userDir, '.env');
      
      if (!fs.existsSync(envTemplatePath)) {
        console.error(`Error: .env.example not found at ${envTemplatePath}`);
        return false;
      }
      
      // Copy template file
      fs.copyFileSync(envTemplatePath, destEnvPath);
      console.log(`Copied .env.example to ${destEnvPath}`);
      
      // Calculate trading parameters with proper error handling
      let buyAmount, sellAmount, takeProfit, stopLoss, dcaAmount, walletAmount;
      
      try {
        buyAmount = this.tradeStrategy.calculateBuyAmount(userData);
        sellAmount = this.tradeStrategy.calculateSellAmount(userData);
        takeProfit = this.tradeStrategy.calculateTakeProfit(userData);
        stopLoss = this.tradeStrategy.calculateStopLoss(userData);
        dcaAmount = this.tradeStrategy.calculateDCAAmount(userData);
        
        // Calculate wallet amount if not already calculated
        if (!userData.calculatedSolAmount && userData.walletCount && userData.totalBalance) {
          const walletAmountResult = this.tradeStrategy.calculateWalletAmount(userData);
          walletAmount = walletAmountResult.solAmount;
          console.log(`Calculated wallet amount: ${walletAmount} SOL`);
        } else if (userData.calculatedSolAmount) {
          walletAmount = userData.calculatedSolAmount;
          console.log(`Using pre-calculated wallet amount: ${walletAmount} SOL`);
        } else {
          // Default to a small amount only if absolutely no calculation is possible
          walletAmount = 0.0001;
          console.log(`Using default wallet amount: ${walletAmount} SOL (calculation not possible)`);
        }
      } catch (calcError) {
        console.error('Error calculating trading parameters:', calcError);
        // Use fallbacks
        buyAmount = userData.buyAmount || 0.05;
        sellAmount = userData.sellAmount || 100;
        takeProfit = userData.profitMargin || 50;
        stopLoss = userData.stopLoss || 50;
        dcaAmount = userData.dcaAmount || 0.025;
        walletAmount = userData.calculatedSolAmount || 0.0001;
      }
      
      // Read, update, and append to .env file
      let envContent = fs.readFileSync(destEnvPath, 'utf8');
      envContent = envContent.replace(/^TRADE_TYPE=.*$/m, 'TRADE_TYPE=sol_spl');
      
      const additionalConfig = `
# Market maker specific settings
CHAT_ID=${chatId}
JITO=false
CONTRACT_ADDRESS=${userData.contractAddress || ''}
TOKEN_DECIMALS=${userData.tokenDecimals || 6}
TOKEN_SYMBOL=${userData.tokenSymbol || ''}
BATCH_SIZE=${userData.batchSize || 1}
BOOST_TYPE=${userData.boostType || 'none'}
BUY_AMOUNT=${buyAmount}
SELL_AMOUNT=${sellAmount}
TAKE_PROFIT=${takeProfit}
STOP_LOSS=${stopLoss}
DCA_AMOUNT=${dcaAmount}
SENDER_WALLET=${userData.userKeypair.publicKey.toString() || ''} //This is the LABS wallet
AMOUNT_PER_WALLET=${walletAmount}
SIGNAL_ONLY=false
ENV_PATH=${ENV_PATH}
# Dummy values for services not needed in market maker instances
MM_MODE=true
`;
      
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

}

module.exports = InstanceManager;