require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const Docker = require('dockerode');
const DataManager = require('../database');
const { Firestore } = require('@google-cloud/firestore');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const ENV_PATH = process.env.ENV_PATH;

class InstanceInitializer {
  constructor() {
    this.basePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker'); // Correct base path
    this.instancePath = path.resolve(os.homedir(), ENV_PATH, 'instances'); // Correct instance path
    this.dataManager = new DataManager();
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });

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
      console.log('User directory', userDir)
      if (!fs.existsSync(userDir)) {
        console.log('!User directory', userDir)
        fs.mkdirSync(userDir, { recursive: true });
      }

      this.copyRecursiveSync(this.basePath, userDir);

      const envFilePath = path.join(userDir, '.env');
      const envContent = `CHAT_ID=${chatId}\nCONTRACT_ADDRESS=${contractAddress}\nBATCH_SIZE=${batchSize}\n`;
      fs.writeFileSync(envFilePath, envContent);
      console.log('Env path', envFilePath)

      await this.buildAndRunDockerContainer(chatId, userDir);
    } catch (error) {
      console.error('Error initializing market maker instance:', error);
    }
  }

  copyRecursiveSync(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();
    console.log('copying', exists, stats, isDirectory)

    if (isDirectory) {
      console.log('Checking..', exists, stats, isDirectory)
      if (!fs.existsSync(dest)) {
        console.log('More Checking..', exists, stats, isDirectory)
        fs.mkdirSync(dest);
      }
      fs.readdirSync(src).forEach((childItemName) => {
        console.log('Fore each..',childItemName)
        this.copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
      });
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  async buildAndRunDockerContainer(chatId, userDir) {
    const imageName = `koynlabs-${chatId}`;
    const containerName = `koynlabs-instance-${chatId}`;
    const buildCommand = `docker build -t ${imageName} ${userDir}`;
    console.log('Building', imageName, containerName, buildCommand)
    try {
      await this.runCommand(buildCommand);
      console.log(`Docker image ${imageName} built successfully`);

      const container = await this.docker.createContainer({
        Image: imageName,
        name: containerName,
        HostConfig: {
          Binds: [`${userDir}:/app`],
          PortBindings: {
            '443/tcp': [
              {
                HostPort: '8443',
              },
            ],
          },
        },
        ExposedPorts: {
          '443/tcp': {},
        },
      });

      await container.start();
      console.log(`Docker container ${containerName} started successfully`);
      const userData = this.firestore.collection(FIRESTORE_COLLECTION).doc(chatId.toString());
      await userData.update({
        instancesCreated: true,
        distributeSolana: false
      });

    } catch (error) {
      console.error('Failed to build or run Docker container:', error);
    }
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