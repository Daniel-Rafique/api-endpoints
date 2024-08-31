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

  async initializeMarketMakerInstance(chatId, userData) {
    try {
      const { contractAddress, batchSize, boostType, buyAmount, sellAmount, senderWallet } = userData;
      const userDir = path.join(this.instancePath, chatId.toString());

      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }

      // 1. Create symbolic links for the user directory
      this.createSymbolicLinksIndividually(this.basePath, userDir);

      // 2. Copy the parent .env file to the user directory, unlink it from the parent directory, and append new parameters
      await this.copyUnlinkAndAppendEnv(userDir, { chatId, contractAddress, batchSize, boostType, buyAmount, sellAmount, senderWallet });

      // 3. Update the firestore flag to indicate that the instance has been created.
      await this.updateFirestoreFlag(chatId);

      // 4. Create wallets for the user and save to wallets.json
      await this.walletProcessor.addJob({ chatId, userData });

      // 5. Distribute Solana to the wallets
      await this.solana.distributeSolana(chatId, userData);

      // 6. Start the market maker instance
      await this.startMarketMakerInstance(chatId, userDir);

    } catch (error) {
      console.error('Error initializing market maker instance:', error);
    }
  }

  createSymbolicLinksIndividually(srcDir, destDir) {
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    entries.forEach(entry => {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);

      if (!fs.existsSync(destPath)) {
        fs.symlinkSync(srcPath, destPath, entry.isDirectory() ? 'junction' : 'file');
      }
    });
  }

  async copyUnlinkAndAppendEnv(userDir, { chatId, contractAddress, batchSize, boostType, buyAmount, sellAmount, senderWallet }) {
    const parentEnvPath = path.join(this.basePath, '.env');
    const destEnvPath = path.join(userDir, '.env');

    // Ensure the original .env file is never modified
    if (fs.existsSync(parentEnvPath)) {
      // Step 1: Copy the parent .env file to /root/devnet-api/instances/{chatId}/.env
      if (!fs.existsSync(destEnvPath)) {
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
    } else {
      console.warn(`No parent .env file found at ${parentEnvPath}.`);
    }
  }

  async updateFirestoreFlag(chatId) {
    try {
      const userDocRef = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatId.toString());
      await userDocRef.update({ instancesCreated: true });
      console.log(`Firestore flag instances created updated for chatId: ${chatId}`);
    } catch (error) {
      console.error('Failed to update Firestore flag for instances created:', error);
    }
  }

  async startMarketMakerInstance(chatId, userDir) {
    const instanceName = `koynlabs-instance-${chatId}`;

    const connectToPM2 = (callback) => {
      pm2.connect((err) => {
        if (err) {
          console.error('Failed to connect to PM2:', err);
          setTimeout(() => connectToPM2(callback), 1000);
          return;
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
          return;
        }

        console.log(`Market maker instance ${instanceName} started successfully`);

        exec('pm2 save', (err, stdout, stderr) => {
          if (err) {
            console.error('Failed to save PM2 process list:', stderr);
            pm2.disconnect();
            return;
          }

          console.log('PM2 process list saved successfully');

          exec('pm2 startup', (err, stdout, stderr) => {
            if (err) {
              console.error('Failed to generate PM2 startup script:', stderr);
            } else {
              console.log('PM2 startup script generated successfully');
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
