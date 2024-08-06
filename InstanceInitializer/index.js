require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Docker = require('dockerode');
const DataManager = require('../database');
const { Firestore } = require('@google-cloud/firestore');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const ENV_PATH = process.env.ENV_PATH;

class InstanceInitializer {
  constructor() {
    this.basePath = path.join(ENV_PATH, 'marketMaker'); // Set the base path correctly
    this.instancePath = path.join(ENV_PATH, 'instances'); // Set the instance path correctly
    this.dataManager = new DataManager();
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });

    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: '.config/firebaseServiceAccountKey.json',
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

      this.copyRecursiveSync(this.basePath, userDir);

      const envFilePath = path.join(userDir, '.env');
      const envContent = `CHAT_ID=${chatId}\nCONTRACT_ADDRESS=${contractAddress}\nBATCH_SIZE=${batchSize}\n`;
      fs.writeFileSync(envFilePath, envContent);

      this.ensureDockerfile(userDir);
      await this.buildAndRunDockerContainer(chatId, userDir);
    } catch (error) {
      console.error('Error initializing market maker instance:', error);
    }
  }

  ensureDockerfile(dest) {
    const dockerfilePath = path.join(this.basePath, 'Dockerfile');
    const destDockerfilePath = path.join(dest, 'Dockerfile');
    if (!fs.existsSync(destDockerfilePath)) {
      fs.copyFileSync(dockerfilePath, destDockerfilePath);
    }
  }

  copyRecursiveSync(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();
    if (isDirectory) {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest);
      }
      fs.readdirSync(src).forEach((childItemName) => {
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