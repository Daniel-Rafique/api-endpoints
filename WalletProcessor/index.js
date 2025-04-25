require('dotenv').config();
const path = require('path');
const os = require('os');
const WalletManager = require('../WalletManager');

const ENV_PATH = process.env.ENV_PATH;

if (!ENV_PATH) {
  throw new Error('ENV_PATH is not defined. Please check your .env file.');
}

/**
 * Simplified WalletProcessor class
 * Calculates optimal wallet counts and distributions based on token metrics
 * Removed neural network complexity and queue management
 */
class WalletProcessor {
  constructor(chatId, processEvents) {
    this.chatId = chatId;
    this.walletManager = new WalletManager(chatId);
    this.processEvents = processEvents; // Store the event emitter
    
    // Define absolute paths
    const basePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker');
    const instancePath = path.resolve(os.homedir(), ENV_PATH, 'marketMaker', 'instances');

    if (!basePath || !instancePath) {
      throw new Error('Error resolving basePath or instancePath.');
    }

    // Constants for wallet calculations
    this.MIN_WALLETS = 3;
    this.MIN_SOL_PER_WALLET = 0.0001;
  }

  /**
   * Calculate the optimal number of wallets based on token metrics
   * Simplified calculation without neural network
   */
  async calculateOptimalWallets(marketCap, liquidity, solAmount, tokenSupply = 1000000000) {
    // Safety checks for input values
    marketCap = Number(marketCap) || 1000;  // Default to 1000 if invalid
    liquidity = Number(liquidity) || 1000;  // Default to 1000 if invalid
    solAmount = Number(solAmount) || 1;     // Default to 1 SOL if invalid
    tokenSupply = Number(tokenSupply) || 1000000000; // Default to 1B if invalid
    
    console.log(`Validated inputs: MarketCap=${marketCap}, Liquidity=${liquidity}, SOL=${solAmount}, Supply=${tokenSupply}`);
    
    // Starting with a maximum of 50 wallets for low cap tokens (reduced by factor of 2)
    let walletCount;
    
    if (marketCap < 1000) {
      // Micro cap tokens - maximum 50 wallets
      walletCount = 50;
    } else if (marketCap < 10000) {
      // Small cap tokens - half of micro caps
      walletCount = 25;
    } else if (marketCap < 50000) {
      // Medium-small cap - half again
      walletCount = 12;
    } else if (marketCap < 200000) {
      // Medium cap - half again
      walletCount = 6;
    } else if (marketCap < 500000) {
      // Medium-large cap
      walletCount = 3;
    } else {
      // Large cap
      walletCount = 3;
    }
    
    // Scale by SOL amount (more SOL = proportionally more wallets)
    walletCount = Math.round(walletCount * Math.min(Math.sqrt(solAmount), 3));
    
    // Ensure we have at least the minimum number of wallets
    walletCount = Math.max(walletCount, this.MIN_WALLETS);

    // Additional safety check
    if (isNaN(walletCount) || walletCount <= 0) {
      console.warn('Invalid wallet count calculated, using minimum:', this.MIN_WALLETS);
      walletCount = this.MIN_WALLETS;
    }

    // Calculate SOL per wallet based on our target wallet count
    const solPerWallet = this.calculateOptimalSolPerWallet(solAmount, walletCount, marketCap, liquidity);
    
    // Additional safety check
    if (isNaN(solPerWallet) || solPerWallet <= 0) {
      console.warn('Invalid SOL per wallet calculated, using minimum:', this.MIN_SOL_PER_WALLET);
      solPerWallet = this.MIN_SOL_PER_WALLET;
    }
    
    // Recalculate wallet count based on the SOL per wallet to ensure we don't exceed our SOL amount
    const maxWalletsFromSol = Math.floor(solAmount / solPerWallet) || this.MIN_WALLETS;
    walletCount = Math.min(walletCount, maxWalletsFromSol);
    
    // Additional safety check after adjustments
    if (isNaN(walletCount) || walletCount <= 0) {
      console.warn('Invalid adjusted wallet count, using minimum:', this.MIN_WALLETS);
      walletCount = this.MIN_WALLETS;
    }
    
    // Calculate trading parameters for these wallets
    const tradingParams = this.calculateTradingParameters(marketCap, liquidity, solPerWallet, tokenSupply);
    
    // Calculate total expected transactions
    const txPerWallet = Math.floor(10 / solPerWallet) || 1; // Estimate 10 transactions per SOL, minimum 1
    const totalTransactions = txPerWallet * walletCount;

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
    SOL per Wallet: ${solPerWallet.toFixed(6)}
    Buying Power per Wallet: $${(solPerWallet * 20).toFixed(2)}
    Expected Transactions: ~${Math.floor(totalTransactions).toLocaleString()} (${txPerWallet.toLocaleString()} per wallet)
    
  Trading Parameters:
    Take Profit: ${tradingParams.takeProfit.toFixed(2)}%
    Stop Loss: ${tradingParams.stopLoss.toFixed(2)}%
    Spread: ${tradingParams.spreadPercentage.toFixed(2)}%
    Avg Order Size: ${tradingParams.orderSize.toFixed(2)} tokens
    Expected Slippage: ${tradingParams.expectedSlippage.toFixed(4)}%
    
  Market Making Impact:
    Avg Trade Size: $${(solPerWallet * 20 * 0.25).toFixed(4)} (25% of wallet)
    Max Trade Size: $${(solPerWallet * 20 * 0.5).toFixed(4)} (50% of wallet)
    Liquidity Impact per Trade: ${((solPerWallet * 20 * 0.25 / liquidity) * 100).toFixed(4)}%
    `);

    return {
      walletCount,
      solPerWallet,
      tradingParams,
      expectedTransactions: Math.floor(totalTransactions)
    };
  }

  calculateOptimalSolPerWallet(totalSol, walletCount, marketCap, liquidity) {
    // Safety checks for input values
    totalSol = Number(totalSol) || 1;         // Default to 1 SOL if invalid
    walletCount = Number(walletCount) || 3;   // Default to 3 wallets if invalid
    marketCap = Number(marketCap) || 1000;    // Default to 1000 if invalid
    liquidity = Number(liquidity) || 1000;    // Default to 1000 if invalid
    
    // Base calculation - evenly distribute SOL among wallets
    let solPerWallet = totalSol / walletCount;
    
    // Safety check result
    if (isNaN(solPerWallet) || solPerWallet <= 0) {
      console.warn('Invalid SOL per wallet calculation, using default distribution');
      solPerWallet = totalSol / 3; // Default to 3 wallets distribution
    }
    
    // Minimum SOL per wallet - increased to ensure enough buying power
    const MIN_TX_SOL = 0.0001; // Increased minimum SOL per wallet
    
    // Adjust based on liquidity
    const mcapToLiqRatio = marketCap / Math.max(liquidity, 1);
    if (mcapToLiqRatio > 5) {
      // Very illiquid tokens need careful sizing - reduce less
      solPerWallet *= 0.8;
    } else if (mcapToLiqRatio > 2) {
      // Moderately illiquid tokens - reduce less
      solPerWallet *= 0.9;
    }
    
    // Ensure we have enough SOL for trading plus a buffer
    return Math.max(solPerWallet, MIN_TX_SOL);
  }

  calculateTradingParameters(marketCap, liquidity, solPerWallet, tokenSupply) {
    // Take profit should be higher for lower market cap tokens
    // as they tend to be more volatile and have larger price swings
    let takeProfit;
    if (marketCap < 1000) {
      takeProfit = 25; // Slightly reduced from 30% for micro caps
    } else if (marketCap < 10000) {
      takeProfit = 18; // Slightly reduced from 20% for small caps
    } else if (marketCap < 50000) {
      takeProfit = 12; // Slightly reduced from 15% for medium-small caps
    } else if (marketCap < 200000) {
      takeProfit = 8; // Slightly reduced from 10% for medium caps
    } else {
      takeProfit = 5; // Unchanged for larger caps
    }
    
    // Stop loss should be tighter for more liquid tokens
    // and wider for less liquid ones
    let stopLoss;
    if (liquidity < 500) {
      stopLoss = 12; // Tightened from 15% for very low liquidity
    } else if (liquidity < 2000) {
      stopLoss = 10; // Tightened from 12% for low liquidity
    } else if (liquidity < 10000) {
      stopLoss = 8; // Tightened from 10% for medium liquidity
    } else {
      stopLoss = 6; // Tightened from 8% for high liquidity
    }
    
    // Adjust for market cap to liquidity ratio
    const mcapToLiqRatio = marketCap / Math.max(liquidity, 1);
    if (mcapToLiqRatio > 5) {
      stopLoss *= 1.3; // Reduced from 1.5 for very illiquid tokens
    } else if (mcapToLiqRatio > 2) {
      stopLoss *= 1.1; // Reduced from 1.2 for moderately illiquid tokens
    }
    
    // Calculate the estimated token price and average order size
    const estimatedTokenPrice = marketCap / tokenSupply;
    const solValueInUsd = solPerWallet * 20; // Approximate SOL value in USD
    const averageOrderSize = (solValueInUsd * 0.25) / estimatedTokenPrice; // 25% of wallet per order (reduced from 50%)
    
    // Calculate expected slippage based on order size and liquidity
    const expectedSlippage = (solValueInUsd * 0.25 / Math.sqrt(liquidity)) * 100;
    
    // For market making, calculate spread based on liquidity
    // Slightly tighter spreads with more wallet power
    const spreadPercentage = Math.min(Math.max(0.4, 4000 / Math.sqrt(liquidity)), 8);
    
    return {
      takeProfit: Math.min(takeProfit, 40), // Reduced cap from 50% to 40%
      stopLoss: Math.min(stopLoss, 20),     // Reduced cap from 25% to 20%
      orderSize: averageOrderSize,
      expectedSlippage,
      spreadPercentage
    };
  }

  /**
   * Create wallets based on token metrics
   * @param {string} chatId - Chat ID for the user
   * @param {object} userData - User data including token details and SOL amount
   * @returns {object} Result of wallet creation
   */
  async createWallets(chatId, userData) {
    try {
      console.log(`Direct wallet creation for chatId: ${chatId}`);
      
      // Extract required data
      const { solAmount, tokenDetails } = userData;
      
      // Handle undefined solAmount with a default value
      const actualSolAmount = solAmount || 1;
      
      if (!tokenDetails) {
        const error = new Error('Token details could not be retrieved');
        this.processEvents.emit('walletError', { chatId, error: error.message });
        throw error;
      }
      
      // For new tokens, set default values if market cap or liquidity data is missing
      if (!tokenDetails.marketCap) {
        console.log(`Token ${tokenDetails.symbol || 'unknown'} has no market cap data - using defaults for new token`);
        tokenDetails.marketCap = 0;
      }

      if (!tokenDetails.liquidity || !tokenDetails.liquidity.usd) {
        console.log(`Token ${tokenDetails.symbol || 'unknown'} has no liquidity data - using defaults for new token`);
        tokenDetails.liquidity = tokenDetails.liquidity || {};
        tokenDetails.liquidity.usd = 0;
      }
      
      // Calculate optimal wallet count
      console.log(`Calculating optimal wallets for marketCap: ${tokenDetails.marketCap}, liquidity: ${tokenDetails.liquidity.usd}`);
      const result = await this.calculateOptimalWallets(
        tokenDetails.marketCap,
        tokenDetails.liquidity.usd,
        actualSolAmount,
        tokenDetails.supply || 1000000000
      );
      
      // Create the wallets
      console.log(`Creating ${result.walletCount} wallets for chatId: ${chatId}`);
      const walletsArray = await this.walletManager.createSolanaWallets(result.walletCount);
      
      if (!walletsArray || walletsArray.length === 0) {
        const error = new Error('Failed to create wallets - empty array returned');
        this.processEvents.emit('walletError', { chatId, error: error.message });
        throw error;
      }
      
      // Save the wallets
      await this.walletManager.saveWallets(chatId, walletsArray);
      
      console.log(`Successfully created and saved ${walletsArray.length} wallets for chatId: ${chatId}`);
      
      // Emit successful completion event
      this.processEvents.emit('walletCreated', { 
        chatId, 
        walletCount: walletsArray.length,
        message: 'Wallets created successfully' 
      });
      
      return { success: true, walletCount: walletsArray.length };
    } catch (error) {
      console.error(`Error creating wallets for chatId ${chatId}:`, error);
      this.processEvents.emit('walletError', { chatId, error: error.message });
      throw error;
    }
  }
}

module.exports = WalletProcessor;