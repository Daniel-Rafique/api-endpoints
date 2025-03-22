const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const pm2 = require('pm2');
const dataManager = require('../database');
const { Firestore } = require('@google-cloud/firestore');
const WalletProcessor = require('../WalletProcessor');
const Commission = require('../Solana/Commission');
const Distribute = require('../Solana/Distribute');
const TopUp = require('../Solana/TopUp');
const TradeStrategy = require('../TradeStrategy');
const FIRESTORE_KEYSTORE = process.env.FIRESTORE_KEYSTORE;
const ENV_PATH = process.env.ENV_PATH;

class InstanceManager {
  constructor(chatId) {
    // ENV_PATH=/root/marketMaker/
    this.basePath = path.resolve(os.homedir(), ENV_PATH);
    // Path to the specific sol_spl template we want to use
    this.templatePath = path.resolve(os.homedir(), ENV_PATH, 'instances', 'sol_spl');
    // Path where user instances will be created
    this.instancePath = path.resolve(os.homedir(), ENV_PATH, 'instances', 'user');
    this.dataManager = dataManager;
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: path.join(os.homedir(), FIRESTORE_KEYSTORE, '.config/firebaseServiceAccountKey.json'),
    });

    this.walletProcessor = new WalletProcessor(chatId);
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
                await this.walletProcessor.addJob({ chatId, userData });
                await this.waitForJobCompletion(chatId);
                await this.dataManager.updateCollection(chatIdStr, { walletsCreated: true });
                console.log('Wallets created.');
              } else {
                console.log('Wallets already created.');
              }
              break;

            case "CHECK_COMMISSION_PAID":
              if (userData.walletsCreated && !userData.commissionPaid) {
                console.log('Commission not paid. Sending commission...');
                await this.dataManager.updateCollection(chatIdStr, { commissionPaid: true });
                await this.commissionPaid.sendToCommissionWallet(chatId, userData, interaction);
                console.log('Commission sent successfully.');
              } else {
                console.log('Commission already paid.');
              }
              break;

            case "CHECK_SOLANA_DISTRIBUTION":
              if (userData.commissionPaid && !userData.distributeSolana) {
                console.log('Distributing Solana...');
                // await this.distributeSolana.distributeSolana(chatId, userData, interaction);
                await this.dataManager.updateCollection(chatIdStr, { distributeSolana: true });
                console.log('Solana distributed successfully.');
              } else {
                console.log('Solana already distributed.');
              }
              break;

            case "CHECK_INSTANCES_STARTED":
              if (!userData.instancesStarted) {
                console.log('Starting market maker instance...');
                // await this.startMarketMakerInstance(chatId, userDir);
                await this.dataManager.updateCollection(chatIdStr, {
                  instancesStarted: true,
                  commissionPaid: true,
                  distributeSolana: true,
                  topUpState: false
                });
                console.log('Market maker instance started successfully.');
              } else {
                console.log('Market maker instance already started.');
              }
              break;

            case "CHECK_TOPUP_STATE":
              if (userData.topUpState) {
                console.log('Distributing topup...');
                await this.topUp.handleCommission(chatId, userData);
                await this.dataManager.updateCollection(chatIdStr, {
                  topUpState: false
                });
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

  async createLightweightSolSplInstance(userDir, chatId, userData) {
    try {
      // Check if source template exists
      if (!fs.existsSync(this.templatePath)) {
        throw new Error(`Template directory not found: ${this.templatePath}`);
      }

      console.log(`Creating lightweight instance from template: ${this.templatePath}`);
      
      // Copy essential files and create symlinks for others
      await this.copyEssentialFilesAndSymlinkOthers(this.templatePath, userDir);
      
      // Create or update .env file with user-specific configuration
      await this.createCustomEnvFile(userDir, chatId, userData);
      
      console.log(`Lightweight SOL/SPL instance created successfully at ${userDir}`);
      return true;
    } catch (error) {
      console.error('Error creating lightweight SOL/SPL instance:', error);
      throw error;
    }
  }

  async copyEssentialFilesAndSymlinkOthers(srcDir, destDir) {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    
    // Files we want to copy (not symlink)
    const filesToCopy = ['.env.example', 'package.json', 'tsconfig.json'];
    
    // Create dist directory if it doesn't exist
    const distDir = path.join(destDir, 'dist');
    if (!fs.existsSync(distDir)) {
      fs.mkdirSync(distDir, { recursive: true });
    }
    
    // Copy or symlink files from template
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (entry.isDirectory()) {
        // For dist directory, we'll copy essential files later
        if (entry.name === 'dist') {
          continue;
        }
        
        // Other directories we can symlink
      if (!fs.existsSync(destPath)) {
          console.log(`Creating symlink for directory: ${entry.name}`);
          fs.symlinkSync(srcPath, destPath, 'junction');
        }
      } else {
        // For files, either copy or symlink based on our list
        if (filesToCopy.includes(entry.name)) {
          console.log(`Copying file: ${entry.name}`);
          fs.copyFileSync(srcPath, destPath);
        } else if (!fs.existsSync(destPath)) {
          console.log(`Creating symlink for file: ${entry.name}`);
          fs.symlinkSync(srcPath, destPath, 'file');
        }
      }
    }
    
    // Copy essential files from dist directory
    const srcDistDir = path.join(srcDir, 'dist');
    if (fs.existsSync(srcDistDir)) {
      const distEntries = fs.readdirSync(srcDistDir, { withFileTypes: true });
      
      for (const entry of distEntries) {
        const srcDistPath = path.join(srcDistDir, entry.name);
        const destDistPath = path.join(distDir, entry.name);
        
        // Only copy index.js and essential modules
        if (entry.name === 'index.js' || entry.name.startsWith('solana-') || entry.name.startsWith('spl-')) {
          console.log(`Copying dist file: ${entry.name}`);
          if (entry.isDirectory()) {
            fs.mkdirSync(destDistPath, { recursive: true });
            this.copyDirSync(srcDistPath, destDistPath);
          } else {
            fs.copyFileSync(srcDistPath, destDistPath);
          }
        } else if (!fs.existsSync(destDistPath)) {
          // Symlink other files/directories
          console.log(`Creating symlink for dist file/dir: ${entry.name}`);
          fs.symlinkSync(srcDistPath, destDistPath, entry.isDirectory() ? 'junction' : 'file');
        }
      }
    }
  }
  
  // Helper method to recursively copy directories
  copyDirSync(src, dest) {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        this.copyDirSync(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  async createCustomEnvFile(userDir, chatId, userData) {
    const destEnvPath = path.join(userDir, '.env');
    const templateEnvPath = path.join(this.templatePath, '.env.example');
    
    // Copy the template .env if it exists
    if (fs.existsSync(templateEnvPath)) {
      console.log(`Using template .env from ${templateEnvPath}`);
      fs.copyFileSync(templateEnvPath, destEnvPath);
    } else {
      // Create empty .env file
      console.log('Creating empty .env file');
      fs.writeFileSync(destEnvPath, '');
    }
    
    // Calculate trading parameters
    const buyAmount = this.tradeStrategy.calculateBuyAmount(userData);
    const sellAmount = this.tradeStrategy.calculateSellAmount(userData);
    const takeProfit = this.tradeStrategy.calculateTakeProfit(userData);
    const stopLoss = this.tradeStrategy.calculateStopLoss(userData);
    const dcaAmount = this.tradeStrategy.calculateDCAAmount(userData);

    // Add sol_spl specific configuration
    const envContent = `
CHAT_ID=${chatId}
TRADE_TYPE=sol_spl
CONTRACT_ADDRESS=${userData.tokenDetails.mintAddress}
TOKEN_DECIMALS=${userData.tokenDetails.decimals}
TOKEN_SYMBOL=${userData.tokenDetails.symbol}
BATCH_SIZE=${userData.batchSize}
BOOST_TYPE=${userData.boostType}
BUY_AMOUNT=${buyAmount}
SELL_AMOUNT=${sellAmount}
TAKE_PROFIT=${takeProfit}
STOP_LOSS=${stopLoss}
DCA_AMOUNT=${dcaAmount}
SENDER_WALLET=${userData.senderWallet}
AMOUNT_PER_WALLET=${userData.amountPerWallet}
SIGNAL_ONLY=false
ENV_PATH=${ENV_PATH}
`;

    fs.appendFileSync(destEnvPath, envContent);
    console.log(`Added custom SOL/SPL configuration to ${destEnvPath}`);
  }

  // Modify waitForJobCompletion to include a timeout
  async waitForJobCompletion(chatId, timeout = 300000) { // 5 minutes timeout
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Wallet job for chatId ${chatId} timed out after ${timeout}ms`));
      }, timeout);

      const completionHandler = (job) => {
        if (job.data.chatId === chatId) {
          clearTimeout(timer);
          this.walletProcessor.walletQueue.removeListener('completed', completionHandler);
          this.walletProcessor.walletQueue.removeListener('failed', failureHandler);
          console.log(`Wallet job completed for chatId: ${chatId}`);
          resolve();
        }
      };

      const failureHandler = (job, err) => {
        if (job.data.chatId === chatId) {
          clearTimeout(timer);
          this.walletProcessor.walletQueue.removeListener('completed', completionHandler);
          this.walletProcessor.walletQueue.removeListener('failed', failureHandler);
          console.error(`Wallet job failed for chatId: ${chatId}`, err);
          reject(err);
        }
      };

      this.walletProcessor.walletQueue.on('completed', completionHandler);
      this.walletProcessor.walletQueue.on('failed', failureHandler);
    });
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
