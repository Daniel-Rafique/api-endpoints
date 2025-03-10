require('dotenv').config();
const path = require('path');
const os = require('os');
const { Queue, Worker } = require('bullmq');
const DataManager = require('../database');
const WalletManager = require('../WalletManager');
const brain = require('brain.js');

const ENV_PATH = process.env.ENV_PATH;

if (!ENV_PATH) {
  throw new Error('ENV_PATH is not defined. Please check your .env file.');
}

class WalletProcessor {
  constructor(chatId) {
    this.chatId = chatId;
    this.walletManager = new WalletManager(chatId);
    // Define absolute paths
    const basePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker');
    const instancePath = path.resolve(os.homedir(), ENV_PATH, 'instances');

    if (!basePath || !instancePath) {
      throw new Error('Error resolving basePath or instancePath.');
    }

    this.dataManager = new DataManager();
    this.network = this.initializeNeuralNetwork();

    this.walletQueue = new Queue('walletQueue', {
      connection: {
        host: 'localhost',
        port: 6379
      }
    });

    this.initializeWorker();
  }

  initializeNeuralNetwork() {
    // Create a neural network with a hidden layer
    const network = new brain.NeuralNetwork({
      hiddenLayers: [4],
      activation: 'sigmoid'
    });

    // Training data: [marketCap, liquidity] => [walletMultiplier]
    // The walletMultiplier will be used to adjust the number of wallets
    const trainingData = [
      // Low market cap, low liquidity - create more wallets to boost visibility
      { input: { marketCap: 0.01, liquidity: 0.01 }, output: { walletMultiplier: 0.9 } },
      { input: { marketCap: 0.05, liquidity: 0.05 }, output: { walletMultiplier: 0.85 } },
      
      // Low market cap, medium liquidity - create moderate number of wallets
      { input: { marketCap: 0.05, liquidity: 0.3 }, output: { walletMultiplier: 0.7 } },
      { input: { marketCap: 0.1, liquidity: 0.4 }, output: { walletMultiplier: 0.65 } },
      
      // Medium market cap, low liquidity - create more wallets to boost liquidity
      { input: { marketCap: 0.3, liquidity: 0.05 }, output: { walletMultiplier: 0.8 } },
      { input: { marketCap: 0.4, liquidity: 0.1 }, output: { walletMultiplier: 0.75 } },
      
      // Medium market cap, medium liquidity - balanced approach
      { input: { marketCap: 0.3, liquidity: 0.3 }, output: { walletMultiplier: 0.6 } },
      { input: { marketCap: 0.5, liquidity: 0.5 }, output: { walletMultiplier: 0.5 } },
      
      // High market cap, low liquidity - create moderate wallets
      { input: { marketCap: 0.8, liquidity: 0.1 }, output: { walletMultiplier: 0.6 } },
      
      // High market cap, high liquidity - create fewer wallets (already visible)
      { input: { marketCap: 0.8, liquidity: 0.8 }, output: { walletMultiplier: 0.3 } },
      { input: { marketCap: 1.0, liquidity: 1.0 }, output: { walletMultiplier: 0.2 } }
    ];
    
    // Train the network
    network.train(trainingData, {
      iterations: 10000,
      errorThresh: 0.005,
      log: false
    });
    
    console.log('Neural network trained for wallet optimization');
    return network;
  }
  
  normalizeInput(marketCap, liquidity) {
    // Normalize inputs to 0-1 range using log scale for better distribution
    const normalizedMarketCap = Math.min(Math.log10(marketCap + 1) / 7, 1);
    const normalizedLiquidity = Math.min(Math.log10(liquidity + 1) / 7, 1);
    
    return {
      marketCap: normalizedMarketCap,
      liquidity: normalizedLiquidity
    };
  }

  initializeWorker() {
    new Worker('walletQueue', async job => {
      const { chatId, userData } = job.data;
      const { makers, boostType, userKeypair, tokenDetails } = userData;
      console.log('Processing job for chatId:', chatId); // Log chatId

      try {
        let walletsArray;
        // Get liquidity and market cap from token details
        const liquidity = tokenDetails.liquidity || 1000;
        const marketCap = tokenDetails.marketCap || 1000;

        console.log(`Token metrics - Liquidity: $${liquidity}, Market Cap: $${marketCap}`);
        
        // Normalize the input values for the neural network
        const normalizedInput = this.normalizeInput(marketCap, liquidity);
        
        // Run the neural network to get the optimal wallet multiplier
        const result = this.network.run(normalizedInput);
        
        // Calculate the optimized number of wallets
        const walletMultiplier = result.walletMultiplier;
        const optimizedWalletCount = Math.max(5, Math.round(makers * walletMultiplier));
        
        console.log(`Neural network analysis:
          - Normalized Market Cap: ${normalizedInput.marketCap.toFixed(4)}
          - Normalized Liquidity: ${normalizedInput.liquidity.toFixed(4)}
          - Wallet Multiplier: ${walletMultiplier.toFixed(4)}
          - Original Wallet Count: ${makers}
          - Optimized Wallet Count: ${optimizedWalletCount}
        `);

        // Create the optimized number of wallets
        walletsArray = await this.walletManager.createSolanaWallets(optimizedWalletCount);

        await this.walletManager.saveWallets(chatId, walletsArray);
        console.log(`Processed ${walletsArray.length} wallets for chatId: ${chatId}`);

      } catch (error) {
        console.error('Error processing job:', error);
        throw new Error('Failed to process job');
      }
    }, {
      connection: {
        host: 'localhost',
        port: 6379
      }
    });
  }

  addJob(data) {
    console.log('Adding create wallet job to queue:', data);
    return this.walletQueue.add('createWallets', data);
  }
}

module.exports = WalletProcessor;