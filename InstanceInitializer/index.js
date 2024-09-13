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

const FIRESTORE_KEYSTORE = process.env.FIRESTORE_KEYSTORE;
const ENV_PATH = process.env.ENV_PATH;

class InstanceInitializer {
  constructor() {
    this.basePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker');
    this.instancePath = path.resolve(os.homedir(), ENV_PATH, 'instances');
    this.dataManager = new DataManager();
    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: path.join(os.homedir(), FIRESTORE_KEYSTORE, '.config/firebaseServiceAccountKey.json'),
    });

    this.distributeSolana = new Distribute();
    this.commissionPaid = new Commission();

    this.walletProcessor = new WalletProcessor();
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

      const steps = [
        "CHECK_INSTANCES_CREATED",
        "CHECK_WALLETS_CREATED",
        "CHECK_COMMISSION_PAID",
        "CHECK_SOLANA_DISTRIBUTION",
        "CHECK_INSTANCES_STARTED"
      ];

      for (const step of steps) {
        console.log(`Processing step: ${step}`);

        // Fetch fresh user data before each step
        let userData = await this.dataManager.getCollection(chatId);
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
                  commissionPaid: false, // Reset for future transactions
                  distributeSolana: false // Reset for future distributions
                });
                console.log('Market maker instance started successfully.');
              } else {
                console.log('Market maker instance already started.');
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

  async copyUnlinkAndAppendEnv(userDir, chatId, {contractAddress, tokenDetails ,batchSize, boostType, buyAmount, sellAmount, senderWallet }) {
    const parentEnvPath = path.join(this.basePath, '.env');
    const destEnvPath = path.join(userDir, '.env');

    // Ensure the original .env file is never modified
    if (fs.existsSync(parentEnvPath)) {
      console.log(`Parent .env file found at ${parentEnvPath}`);
      // Step 1: Copy the parent .env file to /root/devnet-api/instances/{chatId}/.env
      if (!fs.existsSync(destEnvPath)) {
        console.log(`Copying parent .env file to ${destEnvPath}`);
        fs.copyFileSync(parentEnvPath, destEnvPath);
        console.log(`Copied parent .env file to ${destEnvPath}`);
      } else {
        console.log(`.env file already exists at ${destEnvPath}, skipping copy.`);
      }

      // Step 2: Unlink the .env file from the parent directory if it's a symlink
      try {
        if (fs.existsSync(destEnvPath) && fs.lstatSync(destEnvPath).isSymbolicLink()) {
          fs.unlinkSync(destEnvPath);  // Remove the symlink
          console.log(`Removed symlink to .env at ${destEnvPath}`);
          // Re-copy the parent .env file after unlinking
          fs.copyFileSync(parentEnvPath, destEnvPath);
          console.log(`Re-copied parent .env file to ${destEnvPath} after unlinking`);
        } else {
          console.log(`.env at ${destEnvPath} is not a symlink.`);
        }
      } catch (error) {
        console.error(`Failed to unlink .env at ${destEnvPath}:`, error);
      }

      // Step 3: Append new parameters to the copied .env file
      const envContent = `\nCHAT_ID=${chatId}\nCONTRACT_ADDRESS=${contractAddress}\nTOKEN_SYMBOL=${tokenDetails.symbol}\nBATCH_SIZE=${batchSize}\nBOOST_TYPE=${boostType}\nBUY_AMOUNT=${buyAmount}\nSELL_AMOUNT=${sellAmount}\nSENDER_WALLET=${senderWallet}\n`;
      fs.appendFileSync(destEnvPath, envContent);
      console.log(`Appended new parameters to ${destEnvPath}`);
      // Step 4. Update the firestore flag to indicate that the instance has been created.
    } else {
      console.warn(`No parent .env file found at ${parentEnvPath}.`);
      throw new Error('Parent .env file not found');
    }
  }

  async startMarketMakerInstance(chatId, userDir) {
    const instanceName = `koynlabs-instance-${chatId}`;
    console.log(`Starting market maker instance ${instanceName}...`);
    const connectToPM2 = (callback) => {
      pm2.connect((err) => {
        if (err) {
          console.error('Failed to connect to PM2:', err);
          setTimeout(() => connectToPM2(callback), 1000);
          throw new Error('Failed to connect to PM2');
        }
        callback();
      });
    };

    connectToPM2(() => {
      pm2.start({
        script: path.join(userDir, 'dist', 'index.js'),
        name: instanceName,
        cwd: userDir,
        env: {
          NODE_ENV: 'production',
          CHAT_ID: chatId,
        }
      }, (err) => {
        if (err) {
          console.error(`Failed to start market maker instance ${instanceName}:`, err);
          pm2.disconnect();
        }

        console.log(`Market maker instance ${instanceName} started successfully`);

        exec('pm2 save', (err, stdout, stderr) => {
          if (err) {
            console.error('Failed to save PM2 process list:', stderr);
            pm2.disconnect();
          }

          console.log('PM2 process list saved successfully');

          exec('pm2 startup', (err, stdout, stderr) => {
            if (err) {
              console.error('Failed to generate PM2 startup script:', stderr);
            } else {
              console.log('PM2 startup script generated successfully');
              return true;
            }
            pm2.disconnect();
          });
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

module.exports = InstanceInitializer;
