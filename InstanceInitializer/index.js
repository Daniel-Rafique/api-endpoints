require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Docker = require('dockerode');
const DataManager = require('../Database');

class InstanceInitializer {
  constructor(basePath, instancePath, receiverKeypair) {

    console.log(receiverKeypair)
    
    this.basePath = basePath;
    this.instancePath = instancePath;
    this.dataManager = new DataManager();
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
  }

  // Function to initialize a market maker instance
  async initializeMarketMakerInstance(chatId) {
    try {
      const userData = await this.dataManager.getCollection(chatId);
      const { contractAddress, batchSize } = userData;
      const userDir = `${this.instancePath}/${chatId}`;
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }

      // Recursively copy the base market maker files to the user directory
      this.copyRecursiveSync(this.basePath, userDir);

      // Append the CHAT_ID and CONTRACT_ADDRESS variables to the .env file without overwriting existing content
      const envFilePath = `${userDir}/.env`;
      const envContent = `CHAT_ID=${chatId}\nCONTRACT_ADDRESS=${contractAddress}\nBATCH_SIZE=${batchSize}\n`;
      if (fs.existsSync(envFilePath)) {
        fs.appendFileSync(envFilePath, envContent);
      } else {
        fs.writeFileSync(envFilePath, envContent);
      }

      // Build and run the Docker container
      await this.buildAndRunDockerContainer(chatId, userDir);
    } catch (error) {
      console.error('Error initializing market maker instance:', error);
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