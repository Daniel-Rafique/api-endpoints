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
    const instancePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker', 'instances');

    if (!basePath || !instancePath) {
      throw new Error('Error resolving basePath or instancePath.');
    }

    this.dataManager = dataManager;
    this.network = this.initializeNeuralNetwork();
    this.MIN_WALLETS = 10; // Minimum starting point for 1 SOL
    this.MIN_SOL_PER_WALLET = 0.001; // Minimum SOL per wallet

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
      hiddenLayers: [10, 8], // Enhanced network complexity for better pattern recognition
      activation: 'leaky-relu', // Better for continuous number prediction
      learningRate: 0.008     // Slightly reduced for more stable learning
    });

    const trainingData = this.generateTrainingData();
    
    network.train(trainingData, {
      iterations: 75000,      // Increased iterations for better training
      errorThresh: 0.0005,    // Lower error threshold for higher accuracy
      logPeriod: 5000,
      log: (stats) => console.log('Network training stats:', stats)
    });

    return network;
  }
  
  generateTrainingData() {
    const data = [];
    
    // Generate more comprehensive training examples across different market conditions
    for (let marketCap of [500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000]) {
      for (let liquidity of [100, 500, 2000, 5000, 20000, 50000, 200000, 500000]) {
        for (let solAmount of [0.5, 1, 2, 3, 5, 8, 10]) {
          // Calculate ideal wallet count based on market conditions
          const baseWalletCount = this.calculateBaseWalletCount(marketCap, liquidity, solAmount);
          
          data.push({
            input: {
              marketCap: this.normalizeValue(marketCap, 2000000),
              liquidity: this.normalizeValue(liquidity, 1000000),
              solAmount: this.normalizeValue(solAmount, 15),
              mcapToLiq: this.normalizeValue(marketCap / liquidity, 10),
              supplyFactor: this.normalizeValue(Math.min(1000000000, Math.pow(10, 9 + Math.random() * 3)), Math.pow(10, 12))
            },
            output: {
              walletMultiplier: this.normalizeValue(baseWalletCount / 100, 15)
            }
          });
        }
      }
    }

    // Add edge cases for micro-cap and highly illiquid tokens
    for (let i = 0; i < 200; i++) {
      const marketCap = 100 + Math.random() * 900;  // 100-1000 range
      const liquidity = 50 + Math.random() * 450;   // 50-500 range
      const solAmount = 0.5 + Math.random() * 2.5;  // 0.5-3 range
      
      const baseWalletCount = this.calculateBaseWalletCount(marketCap, liquidity, solAmount);
      
      data.push({
        input: {
          marketCap: this.normalizeValue(marketCap, 2000000),
          liquidity: this.normalizeValue(liquidity, 1000000),
          solAmount: this.normalizeValue(solAmount, 15),
          mcapToLiq: this.normalizeValue(marketCap / liquidity, 10),
          supplyFactor: this.normalizeValue(Math.pow(10, 9 + Math.random() * 3), Math.pow(10, 12))
        },
        output: {
          walletMultiplier: this.normalizeValue(baseWalletCount / 100, 15)
        }
      });
    }

    return data;
  }

  calculateBaseWalletCount(marketCap, liquidity, solAmount) {
    // Enhanced dynamic wallet calculation for training data
    const mcapFactor = Math.log10(Math.max(marketCap, 100)) / Math.log10(2000000);
    const liqFactor = Math.log10(Math.max(liquidity, 50)) / Math.log10(500000);
    const mcapToLiqRatio = marketCap / Math.max(liquidity, 1);
    
    // More wallets for lower mcap and higher liquidity
    let baseCount = 120 * solAmount * (1.7 - mcapFactor) * (1.2 + liqFactor);
    
    // Progressive adjustments based on market conditions
    if (marketCap < 1000) {
      // Micro-cap tokens need more granular distribution
      baseCount *= 1.5;
    } else if (marketCap > 500000) {
      // Higher cap tokens can use fewer, larger wallets
      baseCount *= 0.7;
    }
    
    // Liquidity-based adjustments
    if (liquidity < 500) {
      // Very low liquidity - we need to be careful not to move the market too much
      baseCount *= 1.4;
    }
    
    // Adjust based on mcap/liquidity ratio for optimal market impact
    if (mcapToLiqRatio < 0.5) baseCount *= 1.4; // Much more fragmented for excellent liquidity
    else if (mcapToLiqRatio < 1) baseCount *= 1.2; // More fragmented for good liquidity
    else if (mcapToLiqRatio > 5) baseCount *= 0.6; // Much less fragmented for very poor liquidity
    else if (mcapToLiqRatio > 2) baseCount *= 0.8; // Less fragmented for poor liquidity
    
    return Math.round(baseCount);
  }

  normalizeValue(value, max) {
    return Math.log2(1 + value) / Math.log2(1 + max);
  }

  denormalizeValue(normalized, max) {
    return Math.pow(2, normalized * Math.log2(1 + max)) - 1;
  }

  async calculateOptimalWallets(marketCap, liquidity, solAmount, tokenSupply = 1000000000) {
    // Prepare input for neural network with additional factors
    const input = {
      marketCap: this.normalizeValue(marketCap, 2000000),
      liquidity: this.normalizeValue(liquidity, 1000000),
      solAmount: this.normalizeValue(solAmount, 15),
      mcapToLiq: this.normalizeValue(marketCap / liquidity, 10),
      supplyFactor: this.normalizeValue(tokenSupply, Math.pow(10, 12))
    };

    // Get network prediction
    const result = this.network.run(input);
    
    // Denormalize the result and calculate wallet count
    const multiplier = this.denormalizeValue(result.walletMultiplier, 15);
    let walletCount = Math.round(this.MIN_WALLETS * multiplier * solAmount);
    
    // Apply constraints
    const maxWalletsFromSol = Math.floor(solAmount / this.MIN_SOL_PER_WALLET);
    walletCount = Math.min(walletCount, maxWalletsFromSol);
    walletCount = Math.max(walletCount, this.MIN_WALLETS);

    // Calculate optimal SOL per wallet based on market conditions
    const solPerWallet = this.calculateOptimalSolPerWallet(solAmount, walletCount, marketCap, liquidity);
    
    // Recalculate wallet count if SOL per wallet is below minimum threshold
    if (solPerWallet < this.MIN_SOL_PER_WALLET) {
      walletCount = Math.floor(solAmount / this.MIN_SOL_PER_WALLET);
    }
    
    // Calculate trading parameters for the wallets
    const tradingParams = this.calculateTradingParameters(marketCap, liquidity, solPerWallet, tokenSupply);

    console.log(`
Neural Network Wallet Analysis:
  Market Metrics:
    Market Cap: $${marketCap.toFixed(2)}
    Liquidity: $${liquidity.toFixed(2)}
    MCap/Liq Ratio: ${(marketCap/liquidity).toFixed(2)}
    Token Supply: ${tokenSupply.toLocaleString()}
    
  Wallet Distribution:
    Total SOL: ${solAmount}
    Optimal Wallet Count: ${walletCount}
    SOL per Wallet: ${solPerWallet.toFixed(6)}
    
  Trading Parameters:
    Take Profit: ${tradingParams.takeProfit.toFixed(2)}%
    Stop Loss: ${tradingParams.stopLoss.toFixed(2)}%
    Avg Order Size: ${tradingParams.orderSize.toFixed(2)} tokens
    Expected Slippage: ${tradingParams.expectedSlippage.toFixed(4)}%
    
  Impact Analysis:
    Network Multiplier: ${multiplier.toFixed(2)}x
    Expected Market Impact: ${this.calculateExpectedImpact(marketCap, liquidity, solAmount, walletCount).toFixed(2)}%
    Avg Trade Size: $${(solPerWallet * 20).toFixed(2)}
    
  Constraints:
    Max Possible Wallets: ${maxWalletsFromSol}
    Min Required Wallets: ${this.MIN_WALLETS}
    Min SOL per Wallet: ${this.MIN_SOL_PER_WALLET}
    `);

    return {
      walletCount,
      solPerWallet,
      tradingParams
    };
  }

  calculateOptimalSolPerWallet(totalSol, walletCount, marketCap, liquidity) {
    // Base calculation
    let solPerWallet = totalSol / walletCount;
    
    // Adjust based on market conditions
    const mcapFactor = Math.log10(Math.max(marketCap, 100)) / Math.log10(1000000);
    const liqFactor = Math.log10(Math.max(liquidity, 50)) / Math.log10(200000);
    
    // For micro-cap tokens, reduce SOL per wallet to avoid large market impact
    if (marketCap < 5000) {
      solPerWallet *= 0.7;
    }
    
    // For low liquidity, reduce SOL per wallet further
    if (liquidity < 1000) {
      solPerWallet *= 0.8;
    }
    
    // Ensure we don't go below minimum
    return Math.max(solPerWallet, this.MIN_SOL_PER_WALLET);
  }

  calculateTradingParameters(marketCap, liquidity, solPerWallet, tokenSupply) {
    // Calculate optimal take profit percentage
    // Lower mcap tokens can aim for higher take profit
    const baseTakeProfit = 40 * Math.pow(marketCap / 1000000, -0.3);
    
    // Calculate stop loss - typically tighter for higher liquidity tokens
    const baseStopLoss = 15 * Math.pow(liquidity / 100000, -0.2);
    
    // Calculate average order size in tokens
    const estimatedTokenPrice = marketCap / tokenSupply;
    const solValueInUsd = solPerWallet * 20; // Approximate SOL value
    const averageOrderSize = (solValueInUsd * 0.5) / estimatedTokenPrice; // 50% of wallet per order
    
    // Calculate expected slippage based on liquidity and order size
    const orderSizeUsd = solValueInUsd * 0.5;
    const expectedSlippage = (orderSizeUsd / Math.sqrt(liquidity)) * 100;
    
    return {
      takeProfit: Math.min(Math.max(baseTakeProfit, 3), 50), // Cap between 3-50%
      stopLoss: Math.min(Math.max(baseStopLoss, 5), 20),     // Cap between 5-20%
      orderSize: averageOrderSize,
      expectedSlippage
    };
  }

  calculateExpectedImpact(marketCap, liquidity, solAmount, walletCount) {
    // Enhanced impact calculation
    const totalValue = solAmount * 20; // Approximate SOL value in USD
    
    // Calculate average trade size
    const avgTradeSize = (totalValue / walletCount) * 0.5; // Assuming 50% of wallet per trade
    
    // Impact on liquidity - sqrt relationship for more realistic slippage modeling
    const impactOnLiquidity = (avgTradeSize / Math.sqrt(liquidity)) * 100 * Math.sqrt(walletCount / 10);
    
    // Impact on market cap - linear but scaled by sqrt of wallet count for distribution effect
    const impactOnMarketCap = (totalValue / marketCap) * 100 * Math.sqrt(walletCount / 20);
    
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