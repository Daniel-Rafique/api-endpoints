require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const pm2 = require('pm2');
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
      this.appendEnvFile(envFilePath, envContent);

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

  appendEnvFile(filePath, content) {
    if (fs.existsSync(filePath)) {
      fs.appendFileSync(filePath, content);
    } else {
      fs.writeFileSync(filePath, content);
    }
  }

  async startMarketMakerInstance(chatId, userDir) {
    const instanceName = `koynlabs-instance-${chatId}`;

    pm2.connect(err => {
      if (err) {
        console.error('Failed to connect to PM2:', err);
        process.exit(2);
      }

      pm2.start({
        script: path.join(userDir, 'dist', 'index.js'),
        name: instanceName,
        cwd: userDir,
        env: {
          NODE_ENV: 'production',
          CHAT_ID: chatId,
          // Add other environment variables here if needed
        }
      }, (err, apps) => {
        if (err) {
          console.error(`Failed to start market maker instance ${instanceName}:`, err);
          pm2.disconnect();
          return;
        }

        console.log(`Market maker instance ${instanceName} started successfully`);

        pm2.save(err => {
          if (err) {
            console.error('Failed to save PM2 process list:', err);
            pm2.disconnect();
            return;
          }

          console.log('PM2 process list saved successfully');

          pm2.startup(err => {
            if (err) {
              console.error('Failed to generate PM2 startup script:', err);
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