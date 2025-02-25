const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const pm2 = require('pm2');
const DataManager = require('../database');
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
    this.basePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker');
    this.instancePath = path.resolve(os.homedir(), ENV_PATH, 'instances');
    this.dataManager = new DataManager();
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

  async initializeMarketMakerInstance(chatId) {
    try {
      console.log('Initializing market maker instance:', chatId);

      const userDir = path.join(this.instancePath, chatId.toString());
      const chatIdStr = chatId.toString();

      // Step 1: Create the user directory if it doesn't exist
      if (!fs.existsSync(userDir)) {
        console.log(`Creating user directory at ${userDir}`);
        fs.mkdirSync(userDir, { recursive: true });
      }

      // Step 2: Create symbolic links for the user directory
      await this.createSymbolicLinksIndividually(this.basePath, userDir);
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
                console.log('Instances not created. Creating now...');
                await this.copyUnlinkAndAppendEnv(userDir, chatId, userData);
                await this.dataManager.updateCollection(chatIdStr, { instancesCreated: true });
                console.log('Instances created.');
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
                await this.commissionPaid.sendToCommissionWallet(userData);
                console.log('Commission sent successfully.');
              } else {
                console.log('Commission already paid.');
              }
              break;

            case "CHECK_SOLANA_DISTRIBUTION":
              if (userData.commissionPaid && !userData.distributeSolana) {
                console.log('Distributing Solana...');
                await this.distributeSolana.distributeSolana(chatId, userData);
                await this.dataManager.updateCollection(chatIdStr, { distributeSolana: true });
                console.log('Solana distributed successfully.');
              } else {
                console.log('Solana already distributed.');
              }
              break;

            case "CHECK_INSTANCES_STARTED":
              if (!userData.instancesStarted) {
                console.log('Starting market maker instance...');
                await this.startMarketMakerInstance(chatId, userDir);
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
          // Optionally, update Firestore with the error state
          await this.dataManager.updateCollection(chatIdStr, { lastError: `Error in ${step}: ${stepError.message}` });
          throw stepError; // Re-throw to stop the process
        }
      }

      console.log('Market maker instance initialization completed successfully.');

    } catch (error) {
      console.error('Error initializing market maker instance:', error);
      throw error;
    }
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

  async createSymbolicLinksIndividually(srcDir, destDir) {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    entries.forEach(entry => {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (!fs.existsSync(destPath)) {
        console.log(`Creating symbolic link from ${srcPath} to ${destPath}`);
        fs.symlinkSync(srcPath, destPath, entry.isDirectory() ? 'junction' : 'file');
      }
    });
  }

  async copyUnlinkAndAppendEnv(userDir, chatId, userData) {
    const parentEnvPath = path.join(this.basePath, '.env');
    const destEnvPath = path.join(userDir, '.env');

    if (fs.existsSync(parentEnvPath)) {
      console.log(`Parent .env file found at ${parentEnvPath}`);

      if (!fs.existsSync(destEnvPath)) {
        console.log(`Copying parent .env file to ${destEnvPath}`);
        fs.copyFileSync(parentEnvPath, destEnvPath);
      }

      try {
        if (fs.existsSync(destEnvPath) && fs.lstatSync(destEnvPath).isSymbolicLink()) {
          fs.unlinkSync(destEnvPath);
          fs.copyFileSync(parentEnvPath, destEnvPath);
        }
      } catch (error) {
        console.error(`Failed to unlink .env at ${destEnvPath}:`, error);
      }

      const buyAmount = this.tradeStrategy.calculateBuyAmount(userData);
      const sellAmount = this.tradeStrategy.calculateSellAmount(userData);
      const takeProfit = this.tradeStrategy.calculateTakeProfit(userData);
      const stopLoss = this.tradeStrategy.calculateStopLoss(userData);
      const dcaAmount = this.tradeStrategy.calculateDCAAmount(userData);

      // Add sol_spl trade type and other parameters
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
`;
      fs.appendFileSync(destEnvPath, envContent);
      console.log(`Appended sol_spl configuration to ${destEnvPath}`);
    } else {
      throw new Error('Parent .env file not found');
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
