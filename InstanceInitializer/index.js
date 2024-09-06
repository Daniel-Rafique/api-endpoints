const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const pm2 = require('pm2');
const DataManager = require('../database');
const { Firestore } = require('@google-cloud/firestore');
const Solana = require('../Solana');
const WalletProcessor = require('../WalletProcessor');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
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
    this.solana = new Solana();
    this.walletProcessor = new WalletProcessor();
  }

  async initializeMarketMakerInstance(chatId) {
    try {
      console.log('Initializing market maker instance:', chatId);
  
      const userDir = path.join(this.instancePath, chatId.toString());
  
      // Step 1: Create the user directory if it doesn't exist
      if (!fs.existsSync(userDir)) {
        console.log(`Creating user directory at ${userDir}`);
        fs.mkdirSync(userDir, { recursive: true });
      }
  
      // Step 2: Create symbolic links for the user directory
      await this.createSymbolicLinksIndividually(this.basePath, userDir);
  
      // Step 3: Retrieve user data from Firestore
      let userData = await this.dataManager.getCollection(chatId);
  
      if (!userData) {
        console.error("userData is undefined. Stopping initialization.");
        return;
      }
  
      // Step 4: Process each stage
      const steps = [
        "CHECK_INSTANCES_CREATED",
        "CHECK_WALLETS_CREATED",
        "CHECK_COMMISSION_PAID",
        "CHECK_SOLANA_DISTRIBUTION",
        "CHECK_INSTANCES_STARTED"
      ];
  
      for (const step of steps) {
        console.log(`Processing step: ${step}`);
        const chatIdStr = chatId.toString(); // Ensure chatId is a string
        
        switch (step) {
          case "CHECK_INSTANCES_CREATED":
            if (!userData.instancesCreated) {
              console.log("Instances not created, creating now.");
              await this.copyUnlinkAndAppendEnv(userDir, userData);
              userData.instancesCreated = true;
              await this.dataManager.updateCollection(chatIdStr, { instancesCreated: true });
            }
            break;
  
          case "CHECK_WALLETS_CREATED":
            if (!userData.walletsCreated) {
              console.log('Creating wallets for chatId:', chatId);
              await this.walletProcessor.addJob({ chatId, userData });
              await this.waitForJobCompletion(chatId);
              console.log('Wallets created.');
              userData.walletsCreated = true;
              await this.dataManager.updateCollection(chatIdStr, { walletsCreated: true });
            }
            break;
  
          case "CHECK_COMMISSION_PAID":
            if (userData.walletsCreated && !userData.commissionPaid) {
              await this.dataManager.updateCollection(chatIdStr, { commissionPaid: true });
              console.log('Wallets created. Distributing commission to the wallet...');
              const result = await this.solana.handleCommission(chatId, userData);
              console.log('Commission sent successfully. Remaining balance:', result);
              userData.commissionPaid = true;
            }
            break;
  
          case "CHECK_SOLANA_DISTRIBUTION":
            if (userData.commissionPaid && !userData.distributeSolana) {
              await this.dataManager.updateCollection(chatIdStr, { distributeSolana: true });
              console.log('Commission paid. Distributing Solana to the wallet...');
              await this.solana.handleDistribution(chatId, userData);
              console.log('Solana distributed successfully.');
              userData.distributeSolana = true;
            }
            break;
  
          case "CHECK_INSTANCES_STARTED":
            if (!userData.instancesStarted) {
              console.log('Starting market maker instance...');
              await this.startMarketMakerInstance(chatId, userDir);
              console.log('Market maker instance started successfully.');
              userData.instancesStarted = true;
              await this.dataManager.updateCollection(chatIdStr, {instancesStarted: true, commissionPaid: false,  distributeSolana: false });

            }
            break;
  
          default:
            console.error('Unknown step:', step);
        }
      }
  
      console.log('Market maker instance initialization completed successfully.');
  
    } catch (error) {
      console.error('Error initializing market maker instance:', error);
      throw error; // Re-throw the error for higher-level error handling
    }
  }


  // Helper function to wait for job completion
  async waitForJobCompletion(chatId) {
    return new Promise((resolve, reject) => {
      // Example: Wait for job to complete
      this.walletProcessor.walletQueue.on('completed', (job) => {
        if (job.data.chatId === chatId) {
          console.log(`Wallet job completed for chatId: ${chatId}`);
          resolve();
        }
      });

      this.walletProcessor.walletQueue.on('failed', (job, err) => {
        if (job.data.chatId === chatId) {
          console.error(`Wallet job failed for chatId: ${chatId}`, err);
          reject(err);
        }
      });
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

  async copyUnlinkAndAppendEnv(userDir, { chatId, contractAddress, batchSize, boostType, buyAmount, sellAmount, senderWallet }) {
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
      const envContent = `\nCHAT_ID=${chatId}\nCONTRACT_ADDRESS=${contractAddress}\nBATCH_SIZE=${batchSize}\nBOOST_TYPE=${boostType}\nBUY_AMOUNT=${buyAmount}\nSELL_AMOUNT=${sellAmount}\nSENDER_WALLET=${senderWallet}\n`;
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
