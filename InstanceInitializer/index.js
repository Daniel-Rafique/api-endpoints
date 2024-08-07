require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const DataManager = require('../database');
const { Firestore } = require('@google-cloud/firestore');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const ENV_PATH = process.env.ENV_PATH;

class InstanceInitializer {
  constructor() {
    this.basePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker'); // Correct base path
    this.instancePath = path.resolve(os.homedir(), ENV_PATH, 'instances'); // Correct instance path
    this.dataManager = new DataManager();

    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: path.join(os.homedir(), '.config/firebaseServiceAccountKey.json'),
    });
  }

  async initializeMarketMakerInstance(chatId) {
    try {
      const userData = await this.dataManager.getCollection(chatId);
      const { contractAddress, batchSize } = userData;
      const userDir = path.join(this.instancePath, chatId.toString());
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }

      this.copyFiles(this.basePath, userDir);

      const envFilePath = path.join(userDir, '.env');
      const envContent = `CHAT_ID=${chatId}\nCONTRACT_ADDRESS=${contractAddress}\nBATCH_SIZE=${batchSize}\n`;
      fs.writeFileSync(envFilePath, envContent);

      await this.startMarketMakerInstance(chatId, userDir);
    } catch (error) {
      console.error('Error initializing market maker instance:', error);
    }
  }

  copyFiles(src, dest) {
    const files = fs.readdirSync(src);
    files.forEach(file => {
      const srcPath = path.join(src, file);
      const destPath = path.join(dest, file);
      const stats = fs.statSync(srcPath);

      if (stats.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          fs.mkdirSync(destPath);
        }
        this.copyFiles(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    });
  }

  async startMarketMakerInstance(chatId, userDir) {
    const instanceName = `koynlabs-instance-${chatId}`;
    const command = `npm start --prefix ${userDir}`;

    this.runCommand(command).then(() => {
      console.log(`Market maker instance ${instanceName} started successfully`);
    }).catch((error) => {
      console.error(`Failed to start market maker instance ${instanceName}:`, error);
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