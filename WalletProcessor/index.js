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

    // Setup Redis connection with proper configuration and error handling
    const redisConfig = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      maxRetriesPerRequest: 5,
      enableReadyCheck: true,
      reconnectOnError: (err) => {
        console.error('Redis connection error:', err);
        return true; // Auto-reconnect on all errors
      }
    };

    // Create queue with proper connection config
    this.walletQueue = new Queue('walletQueue', {
      connection: redisConfig
    });

    this.initializeWorker(redisConfig);
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
    // Starting with a maximum of 1000 wallets for low cap tokens
    let walletCount;
    
    if (marketCap < 1000) {
      // Micro cap tokens - maximum 1000 wallets
      walletCount = 1000;
    } else if (marketCap < 10000) {
      // Small cap tokens - half of micro caps
      walletCount = 500;
    } else if (marketCap < 50000) {
      // Medium-small cap - half again
      walletCount = 250;
    } else if (marketCap < 200000) {
      // Medium cap - half again
      walletCount = 125;
    } else if (marketCap < 500000) {
      // Medium-large cap
      walletCount = 60;
    } else {
      // Large cap
      walletCount = 30;
    }
    
    // Scale by SOL amount (more SOL = proportionally more wallets)
    walletCount = Math.round(walletCount * Math.sqrt(solAmount));
    
    // Ensure we have at least the minimum number of wallets
    walletCount = Math.max(walletCount, this.MIN_WALLETS);
    
    // Calculate SOL per wallet based on our target wallet count
    const solPerWallet = this.calculateOptimalSolPerWallet(solAmount, walletCount, marketCap, liquidity);
    
    // Recalculate wallet count based on the SOL per wallet to ensure we don't exceed our SOL amount
    const maxWalletsFromSol = Math.floor(solAmount / solPerWallet);
    walletCount = Math.min(walletCount, maxWalletsFromSol);
    
    // Calculate trading parameters for these wallets
    const tradingParams = this.calculateTradingParameters(marketCap, liquidity, solPerWallet, tokenSupply);
    
    // Calculate total expected transactions
    const txPerSol = Math.floor(1 / solPerWallet);
    const totalTransactions = txPerSol * solAmount;
    
    console.log(`
Market Making Strategy Analysis:
  Market Metrics:
    Market Cap: $${marketCap.toFixed(2)}
    Liquidity: $${liquidity.toFixed(2)}
    MCap/Liq Ratio: ${(marketCap/liquidity).toFixed(2)}
    Token Supply: ${tokenSupply.toLocaleString()}
    
  Wallet Strategy:
    Total SOL: ${solAmount}
    Wallet Count: ${walletCount.toLocaleString()}
    SOL per Wallet: ${solPerWallet.toFixed(8)}
    Expected Transactions: ~${Math.floor(totalTransactions).toLocaleString()} (${txPerSol.toLocaleString()} per SOL)
    
  Trading Parameters:
    Take Profit: ${tradingParams.takeProfit.toFixed(2)}%
    Stop Loss: ${tradingParams.stopLoss.toFixed(2)}%
    Spread: ${tradingParams.spreadPercentage.toFixed(2)}%
    Avg Order Size: ${tradingParams.orderSize.toFixed(2)} tokens
    Expected Slippage: ${tradingParams.expectedSlippage.toFixed(4)}%
    
  Market Making Impact:
    Avg Trade Size: $${(solPerWallet * 20).toFixed(4)}
    Liquidity Impact per Trade: ${((solPerWallet * 20 / liquidity) * 100).toFixed(4)}%
    `);

    return {
      walletCount,
      solPerWallet,
      tradingParams,
      expectedTransactions: Math.floor(totalTransactions)
    };
  }

  calculateOptimalSolPerWallet(totalSol, walletCount, marketCap, liquidity) {
    // Base calculation - evenly distribute SOL among wallets
    let solPerWallet = totalSol / walletCount;
    
    // The minimum SOL needed per transaction (covers fees)
    const MIN_TX_SOL = 0.000005; // Minimum SOL needed for a transaction
    
    // Adjust based on liquidity
    const mcapToLiqRatio = marketCap / Math.max(liquidity, 1);
    if (mcapToLiqRatio > 5) {
      // Very illiquid tokens need smaller trade sizes
      solPerWallet *= 0.6;
    } else if (mcapToLiqRatio > 2) {
      // Moderately illiquid tokens
      solPerWallet *= 0.8;
    }
    
    // Ensure we have enough SOL for tx fees plus a small buffer
    return Math.max(solPerWallet, MIN_TX_SOL);
  }

  calculateTradingParameters(marketCap, liquidity, solPerWallet, tokenSupply) {
    // Take profit should be higher for lower market cap tokens
    // as they tend to be more volatile and have larger price swings
    let takeProfit;
    if (marketCap < 1000) {
      takeProfit = 30; // 30% for micro caps
    } else if (marketCap < 10000) {
      takeProfit = 20; // 20% for small caps
    } else if (marketCap < 50000) {
      takeProfit = 15; // 15% for medium-small caps
    } else if (marketCap < 200000) {
      takeProfit = 10; // 10% for medium caps
    } else {
      takeProfit = 5; // 5% for larger caps
    }
    
    // Stop loss should be tighter for more liquid tokens
    // and wider for less liquid ones
    let stopLoss;
    if (liquidity < 500) {
      stopLoss = 15; // 15% for very low liquidity
    } else if (liquidity < 2000) {
      stopLoss = 12; // 12% for low liquidity
    } else if (liquidity < 10000) {
      stopLoss = 10; // 10% for medium liquidity
    } else {
      stopLoss = 8; // 8% for high liquidity
    }
    
    // Adjust for market cap to liquidity ratio
    const mcapToLiqRatio = marketCap / Math.max(liquidity, 1);
    if (mcapToLiqRatio > 5) {
      stopLoss *= 1.5; // Wider stop loss for very illiquid tokens
    } else if (mcapToLiqRatio > 2) {
      stopLoss *= 1.2; // Slightly wider stop loss for moderately illiquid tokens
    }
    
    // Calculate the estimated token price and average order size
    const estimatedTokenPrice = marketCap / tokenSupply;
    const solValueInUsd = solPerWallet * 20; // Approximate SOL value in USD
    const averageOrderSize = solValueInUsd / estimatedTokenPrice; // Tokens per order
    
    // Calculate expected slippage based on order size and liquidity
    const expectedSlippage = (solValueInUsd / Math.sqrt(liquidity)) * 100;
    
    // For market making, calculate spread based on liquidity
    const spreadPercentage = Math.min(Math.max(0.5, 5000 / Math.sqrt(liquidity)), 10);
    
    return {
      takeProfit: Math.min(takeProfit, 50), // Cap at 50%
      stopLoss: Math.min(stopLoss, 25),     // Cap at 25%
      orderSize: averageOrderSize,
      expectedSlippage,
      spreadPercentage
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

  async initializeWorker(redisConfig) {
    try {
      // Make sure we pass the same Redis connection config to the worker
      new Worker('walletQueue', async job => {
        const { chatId, userData } = job.data;
        const { solAmount, tokenDetails } = userData;
        
        try {
          console.log(`Processing wallet creation job for chatId: ${chatId}`);
          console.log(`Market cap: ${tokenDetails.marketCap}, Liquidity: ${tokenDetails.liquidity.usd}, SOL: ${solAmount}`);
          
          const result = await this.calculateOptimalWallets(
            tokenDetails.marketCap,
            tokenDetails.liquidity.usd,
            solAmount,
            tokenDetails.supply
          );

          console.log(`Creating ${result.walletCount} wallets with ${result.solPerWallet} SOL per wallet`);
          const walletsArray = await this.walletManager.createSolanaWallets(result.walletCount);
          
          if (!walletsArray || walletsArray.length === 0) {
            throw new Error('Failed to create wallets - empty array returned');
          }
          
          await this.walletManager.saveWallets(chatId, walletsArray);
          
          console.log(`Successfully created and saved ${walletsArray.length} wallets for chatId: ${chatId}`);
          return { success: true, walletCount: walletsArray.length };

        } catch (error) {
          console.error(`Error processing wallet creation job for chatId ${chatId}:`, error);
          throw new Error(`Failed to process wallet creation job: ${error.message}`);
        }
      }, { connection: redisConfig });
      
      console.log('Wallet queue worker initialized successfully');
    } catch (error) {
      console.error('Failed to initialize wallet queue worker:', error);
      // Continue without failing the entire application
    }
  }

  addJob(data) {
    console.log('Adding create wallet job to queue:', data);
    return this.walletQueue.add('createWallets', data);
  }
}

module.exports = WalletProcessor;