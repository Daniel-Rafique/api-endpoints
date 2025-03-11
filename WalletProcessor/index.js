require('dotenv').config();
const path = require('path');
const os = require('os');
const { Queue, Worker } = require('bullmq');
const dataManager = require('../database');
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

    this.dataManager = dataManager;
    this.network = this.initializeNeuralNetwork();
    this.MIN_WALLETS = 10; // Minimum starting point for 1 SOL
    this.MIN_SOL_PER_WALLET = 0.005; // Minimum SOL per wallet

    this.walletQueue = new Queue('walletQueue', {
      connection: {
        host: 'localhost',
        port: 6379
      }
    });

    this.initializeWorker();
  }

  initializeNeuralNetwork() {
    const network = new brain.NeuralNetwork({
      hiddenLayers: [8, 6], // More complex network for better pattern recognition
      activation: 'leaky-relu', // Better for continuous number prediction
      learningRate: 0.01
    });

    const trainingData = this.generateTrainingData();
    
    network.train(trainingData, {
      iterations: 50000,
      errorThresh: 0.001,
      logPeriod: 5000,
      log: (stats) => console.log('Network training stats:', stats)
    });

    return network;
  }
  
  generateTrainingData() {
    const data = [];
    
    // Generate training examples across different market conditions
    for (let marketCap of [1000, 5000, 10000, 50000, 100000, 500000]) {
      for (let liquidity of [500, 2000, 5000, 20000, 50000, 200000]) {
        for (let solAmount of [1, 3, 5, 8]) {
          // Calculate ideal wallet count based on market conditions
          const baseWalletCount = this.calculateBaseWalletCount(marketCap, liquidity, solAmount);
          
          data.push({
            input: {
              marketCap: this.normalizeValue(marketCap, 1000000),
              liquidity: this.normalizeValue(liquidity, 1000000),
              solAmount: this.normalizeValue(solAmount, 10),
              mcapToLiq: this.normalizeValue(marketCap / liquidity, 5)
            },
            output: {
              walletMultiplier: this.normalizeValue(baseWalletCount / 100, 10)
            }
          });
        }
      }
    }

    return data;
  }

  calculateBaseWalletCount(marketCap, liquidity, solAmount) {
    // Dynamic wallet calculation for training data
    const mcapFactor = Math.log10(Math.max(marketCap, 1000)) / Math.log10(1000000);
    const liqFactor = Math.log10(Math.max(liquidity, 500)) / Math.log10(200000);
    const mcapToLiqRatio = marketCap / liquidity;
    
    // More wallets for lower mcap and higher liquidity
    let baseCount = 100 * solAmount * (1.5 - mcapFactor) * (1 + liqFactor);
    
    // Adjust based on mcap/liquidity ratio
    if (mcapToLiqRatio < 0.5) baseCount *= 1.3; // More fragmented for good liquidity
    if (mcapToLiqRatio > 2) baseCount *= 0.8; // Less fragmented for poor liquidity
    
    return Math.round(baseCount);
  }

  normalizeValue(value, max) {
    return Math.log2(1 + value) / Math.log2(1 + max);
  }

  denormalizeValue(normalized, max) {
    return Math.pow(2, normalized * Math.log2(1 + max)) - 1;
  }

  async calculateOptimalWallets(marketCap, liquidity, solAmount) {
    // Prepare input for neural network
    const input = {
      marketCap: this.normalizeValue(marketCap, 1000000),
      liquidity: this.normalizeValue(liquidity, 1000000),
      solAmount: this.normalizeValue(solAmount, 10),
      mcapToLiq: this.normalizeValue(marketCap / liquidity, 5)
    };

    // Get network prediction
    const result = this.network.run(input);
    
    // Denormalize the result and calculate wallet count
    const multiplier = this.denormalizeValue(result.walletMultiplier, 10);
    let walletCount = Math.round(this.MIN_WALLETS * multiplier * solAmount);
    
    // Apply constraints
    const maxWalletsFromSol = Math.floor(solAmount / this.MIN_SOL_PER_WALLET);
    walletCount = Math.min(walletCount, maxWalletsFromSol);
    walletCount = Math.max(walletCount, this.MIN_WALLETS);

    // Calculate metrics
    const solPerWallet = solAmount / walletCount;
    const expectedImpact = this.calculateExpectedImpact(marketCap, liquidity, solAmount, walletCount);

    console.log(`
Neural Network Wallet Analysis:
  Market Metrics:
    Market Cap: $${marketCap.toFixed(2)}
    Liquidity: $${liquidity.toFixed(2)}
    MCap/Liq Ratio: ${(marketCap/liquidity).toFixed(2)}
    
  Wallet Distribution:
    Total SOL: ${solAmount}
    Optimal Wallet Count: ${walletCount}
    SOL per Wallet: ${solPerWallet.toFixed(6)}
    
  Impact Analysis:
    Network Multiplier: ${multiplier.toFixed(2)}x
    Expected Market Impact: ${expectedImpact.toFixed(2)}%
    Avg Trade Size: $${(solPerWallet * 20).toFixed(2)}
    
  Constraints:
    Max Possible Wallets: ${maxWalletsFromSol}
    Min Required Wallets: ${this.MIN_WALLETS}
    Min SOL per Wallet: ${this.MIN_SOL_PER_WALLET}
    `);

    return walletCount;
  }

  calculateExpectedImpact(marketCap, liquidity, solAmount, walletCount) {
    // Estimate potential market impact as percentage
    const totalValue = solAmount * 20; // Approximate SOL value in USD
    const impactOnLiquidity = (totalValue / liquidity) * 100;
    const impactOnMarketCap = (totalValue / marketCap) * 100;
    
    return Math.max(impactOnLiquidity, impactOnMarketCap);
  }

  async initializeWorker() {
    new Worker('walletQueue', async job => {
      const { chatId, userData } = job.data;
      const { solAmount, tokenDetails } = userData;
      
      try {
        const optimalWalletCount = await this.calculateOptimalWallets(
          tokenDetails.marketCap,
          tokenDetails.liquidity.usd,
          solAmount
        );

        const walletsArray = await this.walletManager.createSolanaWallets(optimalWalletCount);
        await this.walletManager.saveWallets(chatId, walletsArray);
        
        console.log(`Created ${walletsArray.length} wallets for chatId: ${chatId}`);

      } catch (error) {
        console.error('Error processing job:', error);
        throw new Error('Failed to process job');
      }
    });
  }

  addJob(data) {
    console.log('Adding create wallet job to queue:', data);
    return this.walletQueue.add('createWallets', data);
  }
}

module.exports = WalletProcessor;