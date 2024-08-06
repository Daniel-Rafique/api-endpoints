require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Docker = require('dockerode');
const DataManager = require('../database');
const { Firestore } = require('@google-cloud/firestore');

const FIRESTORE_COLLECTION = process.env.FIRESTORE_COLLECTION;
const ENV_PATH = process.env.ENV_PATH; // Ensure this is defined

class InstanceInitializer {
  constructor(basePath, instancePath) {
    this.basePath = basePath; // ./marketMaker
    this.instancePath = instancePath; // ./instances
    this.dataManager = new DataManager();
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });

    this.firestore = new Firestore({
      projectId: 'koynlabs-2f749',
      keyFilename: '.config/firebaseServiceAccountKey.json',
    });
  }

  // Function to initialize a market maker instance
  async initializeMarketMakerInstance(chatId) {
    try {
      const userData = await this.dataManager.getCollection(chatId);
      const { contractAddress, batchSize } = userData;
      const userDir = path.join(this.instancePath, chatId.toString());
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }

      // Copy necessary files from marketMaker to the user directory
      this.copyRecursiveSync(this.basePath, userDir);

      // Create the .env file with the specific environment variables
      const envFilePath = path.join(userDir, '.env');
      const envContent = `CHAT_ID=${chatId}\nCONTRACT_ADDRESS=${contractAddress}\nBATCH_SIZE=${batchSize}\n`;
      fs.writeFileSync(envFilePath, envContent);

      // Ensure the Dockerfile is in the correct location
      this.ensureDockerfile(userDir);

      // Build and run the Docker container
      await this.buildAndRunDockerContainer(chatId, userDir);
    } catch (error) {
      console.error('Error initializing market maker instance:', error);
    }
  }

  // Function to ensure Dockerfile is in the correct location
  ensureDockerfile(dest) {
    const dockerfilePath = path.join(this.basePath, 'Dockerfile');
    const destDockerfilePath = path.join(dest, 'Dockerfile');
    if (!fs.existsSync(destDockerfilePath)) {
      fs.copyFileSync(dockerfilePath, destDockerfilePath);
    }
  }

  // Function to recursively copy files and directories
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

  // Function to build and run Docker container
  async buildAndRunDockerContainer(chatId, userDir) {
    const imageName = `koynlabs-${chatId}`;
    const containerName = `koynlabs-instance-${chatId}`;
    const buildCommand = `docker build -t ${imageName} ${userDir}`;

    try {
      await this.runCommand(buildCommand);
      console.log(`Docker image ${imageName} built successfully`);

      // Create and start the Docker container
      const container = await this.docker.createContainer({
        Image: imageName,
        name: containerName,
        HostConfig: {
          Binds: [`${userDir}:/app`], // Mount the user directory inside the container
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

  // Function to run shell commands
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
