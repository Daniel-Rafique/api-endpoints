const brain = require('brain.js');
const fs = require('fs');
const path = require('path');

class TradeStrategy {
    constructor() {
        // Create separate neural networks for different trading decisions
        this.buyNet = new brain.NeuralNetwork({
            hiddenLayers: [10, 8],
            activation: 'sigmoid'
        });

        this.sellNet = new brain.NeuralNetwork({
            hiddenLayers: [10, 8],
            activation: 'sigmoid'
        });

        this.takeProfitNet = new brain.NeuralNetwork({
            hiddenLayers: [8, 6],
            activation: 'sigmoid'
        });

        this.stopLossNet = new brain.NeuralNetwork({
            hiddenLayers: [8, 6],
            activation: 'sigmoid'
        });

        // Add DCA neural network
        this.dcaNet = new brain.NeuralNetwork({
            hiddenLayers: [10, 8],
            activation: 'sigmoid'
        });

        // Load pre-trained models if they exist
        this.loadModels();

        // Initialize metrics storage
        this.metricsHistory = [];
        this.maxHistoryLength = 1000; // Limit history to prevent memory issues

        // Track price history for dip detection
        this.priceHistory = [];
        this.maxPriceHistoryLength = 100;
    }

    // Load pre-trained models from files
    loadModels() {
        try {
            const modelsPath = path.resolve(__dirname, 'models');

            if (fs.existsSync(path.join(modelsPath, 'buyNet.json'))) {
                const buyNetData = JSON.parse(fs.readFileSync(path.join(modelsPath, 'buyNet.json'), 'utf8'));
                this.buyNet.fromJSON(buyNetData);
                console.log('Loaded buy network model');
            }

            if (fs.existsSync(path.join(modelsPath, 'sellNet.json'))) {
                const sellNetData = JSON.parse(fs.readFileSync(path.join(modelsPath, 'sellNet.json'), 'utf8'));
                this.sellNet.fromJSON(sellNetData);
                console.log('Loaded sell network model');
            }

            if (fs.existsSync(path.join(modelsPath, 'takeProfitNet.json'))) {
                const takeProfitNetData = JSON.parse(fs.readFileSync(path.join(modelsPath, 'takeProfitNet.json'), 'utf8'));
                this.takeProfitNet.fromJSON(takeProfitNetData);
                console.log('Loaded take profit network model');
            }

            if (fs.existsSync(path.join(modelsPath, 'stopLossNet.json'))) {
                const stopLossNetData = JSON.parse(fs.readFileSync(path.join(modelsPath, 'stopLossNet.json'), 'utf8'));
                this.stopLossNet.fromJSON(stopLossNetData);
                console.log('Loaded stop loss network model');
            }

            // Load DCA network
            if (fs.existsSync(path.join(modelsPath, 'dcaNet.json'))) {
                const dcaNetData = JSON.parse(fs.readFileSync(path.join(modelsPath, 'dcaNet.json'), 'utf8'));
                this.dcaNet.fromJSON(dcaNetData);
                console.log('Loaded DCA network model');
            }
        } catch (error) {
            console.error('Error loading neural network models:', error);
            // Continue with untrained models if loading fails
        }
    }

    // Save trained models to files
    saveModels() {
        try {
            const modelsPath = path.resolve(__dirname, 'models');

            // Create directory if it doesn't exist
            if (!fs.existsSync(modelsPath)) {
                fs.mkdirSync(modelsPath, { recursive: true });
            }

            fs.writeFileSync(path.join(modelsPath, 'buyNet.json'), JSON.stringify(this.buyNet.toJSON()));
            fs.writeFileSync(path.join(modelsPath, 'sellNet.json'), JSON.stringify(this.sellNet.toJSON()));
            fs.writeFileSync(path.join(modelsPath, 'takeProfitNet.json'), JSON.stringify(this.takeProfitNet.toJSON()));
            fs.writeFileSync(path.join(modelsPath, 'stopLossNet.json'), JSON.stringify(this.stopLossNet.toJSON()));
            fs.writeFileSync(path.join(modelsPath, 'dcaNet.json'), JSON.stringify(this.dcaNet.toJSON()));

            console.log('Saved neural network models');
        } catch (error) {
            console.error('Error saving neural network models:', error);
        }
    }

    // Add new metrics to history and retrain models if needed
    addMetrics(metrics) {
        // Add new metrics to history
        this.metricsHistory.push(metrics);

        // Limit history size
        if (this.metricsHistory.length > this.maxHistoryLength) {
            this.metricsHistory.shift();
        }

        // Add price to price history if available
        if (metrics.tokenPrice) {
            this.priceHistory.push({
                price: metrics.tokenPrice,
                timestamp: Date.now()
            });

            // Limit price history size
            if (this.priceHistory.length > this.maxPriceHistoryLength) {
                this.priceHistory.shift();
            }
        }

        // Retrain models if we have enough data (at least 20 data points)
        if (this.metricsHistory.length >= 20) {
            this.trainModels();
        }
    }

    // Prepare input data for neural networks
    prepareInputData(userData) {
        // Normalize values to be between 0 and 1 for neural network
        const tokenPrice = userData.tokenDetails?.priceUSD || 0;
        const marketCap = userData.tokenDetails?.marketCap || 0;
        const fdv = userData.tokenDetails?.fdv || 0;
        const liquidity = userData.tokenDetails?.liquidity?.usd || 0;

        // Volume data
        const volume24h = userData.tokenDetails?.volume24h || userData.tokenDetails?.volume?.h24 || 0;
        const volume1h = userData.tokenDetails?.volume?.h1 || 0;
        const volume6h = userData.tokenDetails?.volume?.h6 || 0;
        const volume5m = userData.tokenDetails?.volume?.m5 || 0;

        // Price change data
        const priceChange24h = userData.tokenDetails?.priceChange?.h24 || 0;
        const priceChange1h = userData.tokenDetails?.priceChange?.h1 || 0;
        const priceChange6h = userData.tokenDetails?.priceChange?.h6 || 0;
        const priceChange5m = userData.tokenDetails?.priceChange?.m5 || 0;

        // Transaction data - buys
        const buys1h = userData.tokenDetails?.txns?.h1?.buys || 0;
        const buys24h = userData.tokenDetails?.txns?.h24?.buys || 0;
        const buys6h = userData.tokenDetails?.txns?.h6?.buys || 0;
        const buys5m = userData.tokenDetails?.txns?.m5?.buys || 0;

        // Transaction data - sells
        const sells1h = userData.tokenDetails?.txns?.h1?.sells || 0;
        const sells24h = userData.tokenDetails?.txns?.h24?.sells || 0;
        const sells6h = userData.tokenDetails?.txns?.h6?.sells || 0;
        const sells5m = userData.tokenDetails?.txns?.m5?.sells || 0;

        // User data
        const walletBalance = userData.amountPerWallet || 0;
        const totalTrades = userData.totalTrades || 0;
        const successfulTrades = userData.successfulTrades || 0;
        const volatility = userData.volatility || 0;

        // Normalize market metrics
        const normalizedMarketCap = Math.min(marketCap / 1000000000, 1); // Max 1B
        const normalizedFDV = Math.min(fdv / 2000000000, 1); // Max 2B
        const normalizedLiquidity = Math.min(liquidity / 100000000, 1); // Max 100M

        // Normalize volume metrics
        const normalizedVolume24h = Math.min(volume24h / 10000000, 1); // Max 10M
        const normalizedVolume1h = Math.min(volume1h / 1000000, 1); // Max 1M
        const normalizedVolume6h = Math.min(volume6h / 5000000, 1); // Max 5M
        const normalizedVolume5m = Math.min(volume5m / 100000, 1); // Max 100K

        // Normalize price change metrics (-100% to +100%)
        const normalizedPriceChange24h = (priceChange24h + 100) / 200;
        const normalizedPriceChange1h = (priceChange1h + 100) / 200;
        const normalizedPriceChange6h = (priceChange6h + 100) / 200;
        const normalizedPriceChange5m = (priceChange5m + 100) / 200;

        // Normalize transaction counts
        const normalizedBuys1h = Math.min(buys1h / 100, 1); // Max 100 buys
        const normalizedBuys24h = Math.min(buys24h / 1000, 1); // Max 1000 buys
        const normalizedBuys6h = Math.min(buys6h / 500, 1); // Max 500 buys
        const normalizedBuys5m = Math.min(buys5m / 20, 1); // Max 20 buys

        const normalizedSells1h = Math.min(sells1h / 100, 1); // Max 100 sells
        const normalizedSells24h = Math.min(sells24h / 1000, 1); // Max 1000 sells
        const normalizedSells6h = Math.min(sells6h / 500, 1); // Max 500 sells
        const normalizedSells5m = Math.min(sells5m / 20, 1); // Max 20 sells

        // Calculate buy/sell ratio (to detect market sentiment)
        const buyToSellRatio1h = sells1h > 0 ? Math.min(buys1h / sells1h, 5) / 5 : 0.5;
        const buyToSellRatio24h = sells24h > 0 ? Math.min(buys24h / sells24h, 5) / 5 : 0.5;

        // Normalize wallet balance (assuming max of 100 SOL)
        const normalizedBalance = Math.min(walletBalance / 100, 1);

        // Calculate win rate
        const winRate = totalTrades > 0 ? successfulTrades / totalTrades : 0.5;

        // Normalize volatility (0-100%)
        const normalizedVolatility = Math.min(volatility / 100, 1);

        // Return normalized input data with all metrics
        return {
            // Price and market metrics
            price: tokenPrice,
            marketCap: normalizedMarketCap,
            fdv: normalizedFDV,
            liquidity: normalizedLiquidity,

            // Volume metrics
            volume24h: normalizedVolume24h,
            volume1h: normalizedVolume1h,
            volume6h: normalizedVolume6h,
            volume5m: normalizedVolume5m,

            // Price change metrics
            priceChange24h: normalizedPriceChange24h,
            priceChange1h: normalizedPriceChange1h,
            priceChange6h: normalizedPriceChange6h,
            priceChange5m: normalizedPriceChange5m,

            // Transaction metrics
            buys1h: normalizedBuys1h,
            buys24h: normalizedBuys24h,
            buys6h: normalizedBuys6h,
            buys5m: normalizedBuys5m,

            sells1h: normalizedSells1h,
            sells24h: normalizedSells24h,
            sells6h: normalizedSells6h,
            sells5m: normalizedSells5m,

            // Market sentiment metrics
            buyToSellRatio1h,
            buyToSellRatio24h,

            // User metrics
            balance: normalizedBalance,
            winRate,
            volatility: normalizedVolatility
        };
    }

    // Prepare enhanced input data for DCA decisions
    prepareDCAInputData(userData) {
        // Get base input data
        const baseInputData = this.prepareInputData(userData);

        // Calculate additional metrics for DCA decisions

        // 1. Calculate recent price trend (last 24h)
        let recentPriceTrend = 0;
        if (this.priceHistory.length >= 2) {
            const recentPrices = this.priceHistory.slice(-24); // Last 24 data points
            if (recentPrices.length >= 2) {
                const oldestPrice = recentPrices[0].price;
                const newestPrice = recentPrices[recentPrices.length - 1].price;
                recentPriceTrend = (newestPrice - oldestPrice) / oldestPrice;
                // Normalize to 0-1 range (-50% to +50% change)
                recentPriceTrend = Math.max(0, Math.min(1, (recentPriceTrend + 0.5)));
            }
        }

        // 2. Calculate price relative to recent high
        let priceToRecentHigh = 1;
        if (this.priceHistory.length >= 5) {
            const recentPrices = this.priceHistory.slice(-30); // Last 30 data points
            const highestPrice = Math.max(...recentPrices.map(p => p.price));
            const currentPrice = userData.tokenDetails?.price || recentPrices[recentPrices.length - 1].price;
            priceToRecentHigh = currentPrice / highestPrice;
        }

        // 3. Calculate price volatility (standard deviation of recent price changes)
        let priceVolatility = 0;
        if (this.priceHistory.length >= 5) {
            const recentPrices = this.priceHistory.slice(-10); // Last 10 data points
            const priceChanges = [];

            for (let i = 1; i < recentPrices.length; i++) {
                const percentChange = (recentPrices[i].price - recentPrices[i - 1].price) / recentPrices[i - 1].price;
                priceChanges.push(percentChange);
            }

            // Calculate standard deviation
            const mean = priceChanges.reduce((sum, val) => sum + val, 0) / priceChanges.length;
            const squaredDiffs = priceChanges.map(val => Math.pow(val - mean, 2));
            const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / squaredDiffs.length;
            priceVolatility = Math.sqrt(variance);

            // Normalize to 0-1 range (assuming max volatility of 0.5 or 50%)
            priceVolatility = Math.min(priceVolatility / 0.5, 1);
        }

        // Return enhanced input data with DCA-specific metrics
        return {
            ...baseInputData,
            recentPriceTrend,
            priceToRecentHigh,
            priceVolatility
        };
    }

    // Train neural network models with historical data
    trainModels() {
        // Prepare training data for buy network
        const buyTrainingData = this.metricsHistory.map(metrics => ({
            input: this.prepareInputData(metrics),
            output: { buyAmount: metrics.optimalBuyAmount || 0.1 }
        }));

        // Prepare training data for sell network
        const sellTrainingData = this.metricsHistory.map(metrics => ({
            input: this.prepareInputData(metrics),
            output: { sellAmount: metrics.optimalSellAmount || 0.5 }
        }));

        // Prepare training data for take profit network
        const takeProfitTrainingData = this.metricsHistory.map(metrics => ({
            input: this.prepareInputData(metrics),
            output: { takeProfit: metrics.optimalTakeProfit || 0.2 }
        }));

        // Prepare training data for stop loss network
        const stopLossTrainingData = this.metricsHistory.map(metrics => ({
            input: this.prepareInputData(metrics),
            output: { stopLoss: metrics.optimalStopLoss || 0.1 }
        }));

        // Prepare training data for DCA network
        const dcaTrainingData = this.metricsHistory.map(metrics => ({
            input: this.prepareDCAInputData(metrics),
            output: { dcaAmount: metrics.optimalDCAAmount || 0.2 }
        }));

        // Train networks
        console.log('Training neural networks with', this.metricsHistory.length, 'data points');

        this.buyNet.train(buyTrainingData, {
            iterations: 2000,
            errorThresh: 0.005,
            log: false
        });

        this.sellNet.train(sellTrainingData, {
            iterations: 2000,
            errorThresh: 0.005,
            log: false
        });

        this.takeProfitNet.train(takeProfitTrainingData, {
            iterations: 2000,
            errorThresh: 0.005,
            log: false
        });

        this.stopLossNet.train(stopLossTrainingData, {
            iterations: 2000,
            errorThresh: 0.005,
            log: false
        });

        this.dcaNet.train(dcaTrainingData, {
            iterations: 2000,
            errorThresh: 0.005,
            log: false
        });

        // Save trained models
        this.saveModels();
    }

    // Calculate optimal buy amount based on user data
    calculateBuyAmount(userData) {
        try {
            // Default values if neural network isn't trained yet
            if (this.metricsHistory.length < 20) {
                // Conservative default based on wallet balance
                const walletBalance = userData.amountPerWallet || 1;
                return Math.min(0.1 * walletBalance, 0.5); // 10% of balance, max 0.5 SOL
            }

            // Prepare input data
            const inputData = this.prepareInputData(userData);

            // Run neural network
            const result = this.buyNet.run(inputData);

            // Get buy amount from result (between 0 and 1)
            const buyRatio = result.buyAmount;

            // Calculate actual buy amount based on wallet balance
            const walletBalance = userData.amountPerWallet || 1;
            const maxBuyAmount = Math.min(walletBalance * 0.5, 5); // Max 50% of balance or 5 SOL
            const buyAmount = buyRatio * maxBuyAmount;

            // Ensure minimum buy amount
            return Math.max(buyAmount, 0.05);
        } catch (error) {
            console.error('Error calculating buy amount:', error);
            return 0.1; // Default fallback
        }
    }

    // Calculate optimal sell amount based on user data
    calculateSellAmount(userData) {
        try {
            // Default values if neural network isn't trained yet
            if (this.metricsHistory.length < 20) {
                return 0.5; // Default to 50% of position
            }

            // Prepare input data
            const inputData = this.prepareInputData(userData);

            // Run neural network
            const result = this.sellNet.run(inputData);

            // Get sell ratio from result (between 0 and 1)
            const sellRatio = result.sellAmount;

            // Ensure minimum sell amount
            return Math.max(sellRatio, 0.1);
        } catch (error) {
            console.error('Error calculating sell amount:', error);
            return 0.5; // Default fallback
        }
    }

    // Calculate optimal take profit percentage
    calculateTakeProfit(userData) {
        try {
            // Default values if neural network isn't trained yet
            if (this.metricsHistory.length < 20) {
                return 0.2; // Default to 20% take profit
            }

            // Prepare input data
            const inputData = this.prepareInputData(userData);

            // Run neural network
            const result = this.takeProfitNet.run(inputData);

            // Get take profit percentage from result (between 0 and 1)
            const takeProfitRatio = result.takeProfit;

            // Scale to reasonable percentage (5% to 50%)
            return 0.05 + (takeProfitRatio * 0.45);
        } catch (error) {
            console.error('Error calculating take profit:', error);
            return 0.2; // Default fallback
        }
    }

    // Calculate optimal stop loss percentage
    calculateStopLoss(userData) {
        try {
            // Default values if neural network isn't trained yet
            if (this.metricsHistory.length < 20) {
                return 0.1; // Default to 10% stop loss
            }

            // Prepare input data
            const inputData = this.prepareInputData(userData);

            // Run neural network
            const result = this.stopLossNet.run(inputData);

            // Get stop loss percentage from result (between 0 and 1)
            const stopLossRatio = result.stopLoss;

            // Scale to reasonable percentage (5% to 25%)
            return 0.05 + (stopLossRatio * 0.2);
        } catch (error) {
            console.error('Error calculating stop loss:', error);
            return 0.1; // Default fallback
        }
    }

    // Calculate optimal DCA amount based on market conditions
    calculateDCAAmount(userData) {
        try {
            // Check if we have enough price history to make DCA decisions
            if (this.priceHistory.length < 5) {
                return 0; // Not enough data to make DCA decisions
            }

            // Default values if neural network isn't trained yet
            if (this.metricsHistory.length < 20) {
                // Simple dip detection for default behavior
                const recentPrices = this.priceHistory.slice(-5);
                const currentPrice = recentPrices[recentPrices.length - 1].price;
                const maxPrice = Math.max(...recentPrices.map(p => p.price));

                // If price has dropped at least 10% from recent high
                if (currentPrice <= maxPrice * 0.9) {
                    const walletBalance = userData.amountPerWallet || 1;
                    const dipPercentage = 1 - (currentPrice / maxPrice);

                    // Scale DCA amount based on dip size (deeper dip = larger DCA)
                    const dcaRatio = Math.min(dipPercentage * 2, 0.3); // Max 30% of balance
                    return Math.min(dcaRatio * walletBalance, 1); // Max 1 SOL
                }

                return 0; // No dip detected
            }

            // Prepare enhanced input data for DCA
            const inputData = this.prepareDCAInputData(userData);

            // Run neural network
            const result = this.dcaNet.run(inputData);

            // Get DCA amount ratio from result (between 0 and 1)
            const dcaRatio = result.dcaAmount;

            // Calculate actual DCA amount based on wallet balance
            const walletBalance = userData.amountPerWallet || 1;
            const maxDCAAmount = Math.min(walletBalance * 0.3, 2); // Max 30% of balance or 2 SOL
            const dcaAmount = dcaRatio * maxDCAAmount;

            // Only DCA if the amount is significant
            return dcaAmount >= 0.05 ? dcaAmount : 0;
        } catch (error) {
            console.error('Error calculating DCA amount:', error);
            return 0; // Default fallback
        }
    }

    // Determine if we should DCA based on market conditions
    shouldDCA(userData) {
        // Calculate DCA amount
        const dcaAmount = this.calculateDCAAmount(userData);

        // Return decision with amount
        return {
            should: dcaAmount >= 0.05, // Only DCA if amount is at least 0.05 SOL
            amount: dcaAmount
        };
    }

    // Record trade outcome to improve future predictions
    recordTradeOutcome(tradeData) {
        try {
            // Extract relevant metrics from trade outcome
            const {
                initialPrice,
                exitPrice,
                buyAmount,
                sellAmount,
                takeProfit,
                stopLoss,
                profitLoss,
                dcaAmount // Add DCA amount if it was used
            } = tradeData;

            // Validate essential data
            if (initialPrice === undefined || exitPrice === undefined) {
                console.warn('Trade outcome missing essential price data:', tradeData);
                return;
            }

            // Calculate price change percentage
            const priceChangePercent = ((exitPrice - initialPrice) / initialPrice) * 100;

            // Determine if trade was successful (if not explicitly provided)
            const success = tradeData.success !== undefined ? tradeData.success : profitLoss > 0;

            // Determine optimal values based on outcome
            let optimalBuyAmount = buyAmount;
            let optimalSellAmount = sellAmount;
            let optimalTakeProfit = takeProfit;
            let optimalStopLoss = stopLoss;
            let optimalDCAAmount = dcaAmount || 0;

            // Adjust optimal values based on trade outcome
            if (success) {
                // If successful, slightly increase buy amount and take profit
                optimalBuyAmount = buyAmount * 1.05;
                optimalTakeProfit = takeProfit * 1.05;

                // If DCA was used and successful, slightly increase DCA amount
                if (dcaAmount > 0) {
                    optimalDCAAmount = dcaAmount * 1.1;
                }
            } else {
                // If unsuccessful, reduce buy amount and tighten stop loss
                optimalBuyAmount = buyAmount * 0.95;
                optimalStopLoss = stopLoss * 0.9;

                // If DCA was used and unsuccessful, reduce DCA amount
                if (dcaAmount > 0) {
                    optimalDCAAmount = dcaAmount * 0.8;
                }
            }

            // Add to metrics history with additional trade data for future analysis
            this.addMetrics({
                tokenPrice: initialPrice,
                priceChange24h: priceChangePercent,
                optimalBuyAmount,
                optimalSellAmount,
                optimalTakeProfit,
                optimalStopLoss,
                optimalDCAAmount,
                success: success ? 1 : 0,
                profitLoss,
                holdingDuration: tradeData.duration,
                exitPrice
            });

            // Log trade outcome for debugging
            console.log(`Trade outcome recorded: ${success ? 'SUCCESS' : 'FAILURE'} with ${priceChangePercent.toFixed(2)}% change. Initial: ${initialPrice}, Exit: ${exitPrice}`);
        } catch (error) {
            console.error('Error recording trade outcome:', error);
        }
    }

    // Record price update without a trade (for tracking price history)
    recordPriceUpdate(tokenData) {
        try {
            // Only destructure what we actually use
            const { price } = tokenData;

            // Validate price data
            if (price === undefined || price === null) {
                console.warn('Price update received with missing price data:', tokenData);
                return;
            }

            // Add to price history with all relevant data
            this.priceHistory.push({
                price,
                timestamp: Date.now(),
                // Store additional metrics that might be useful for analysis
                marketCap: tokenData.marketCap,
                liquidity: tokenData.liquidity,
                volume24h: tokenData.volume24h,
                priceChange24h: tokenData.priceChange24h
            });

            // Limit price history size
            if (this.priceHistory.length > this.maxPriceHistoryLength) {
                this.priceHistory.shift();
            }

            // Log price update for debugging
            console.log(`Price update recorded: ${price} at ${new Date().toISOString()}`);
        } catch (error) {
            console.error('Error recording price update:', error);
        }
    }

    // Generate synthetic training data to bootstrap the model
    bootstrapWithSyntheticData(numSamples = 50) {
        console.log('Bootstrapping model with synthetic data...');

        // Generate synthetic price history first
        const basePrice = 1.0 + (Math.random() * 10); // Random base price between 1 and 11
        let currentPrice = basePrice;

        // Create 30 days of synthetic price history
        for (let i = 0; i < 30; i++) {
            // Random daily volatility between -8% and +8%
            const dailyChange = currentPrice * (Math.random() * 0.16 - 0.08);
            currentPrice += dailyChange;

            // Ensure price doesn't go negative
            if (currentPrice <= 0) currentPrice = 0.01;

            // Add to price history with timestamp offset by days
            const timestamp = Date.now() - ((30 - i) * 24 * 60 * 60 * 1000);
            this.priceHistory.push({
                price: currentPrice,
                timestamp
            });
        }

        // Generate synthetic trade outcomes
        for (let i = 0; i < numSamples; i++) {
            // Generate random trade parameters
            const initialPrice = currentPrice * (0.9 + Math.random() * 0.2); // ±10% from current price
            const priceChange = Math.random() > 0.5 ?
                Math.random() * 0.3 : // Up to 30% gain
                -Math.random() * 0.2; // Up to 20% loss
            const exitPrice = initialPrice * (1 + priceChange);

            // Random trade parameters
            const buyAmount = 0.1 + Math.random() * 0.9; // 0.1 to 1.0 SOL
            const sellAmount = 0.3 + Math.random() * 0.7; // 30% to 100% of position
            const takeProfit = 0.1 + Math.random() * 0.4; // 10% to 50% take profit
            const stopLoss = 0.05 + Math.random() * 0.15; // 5% to 20% stop loss

            // Determine if trade was successful (either hit take profit or exited with profit)
            const success = priceChange > 0;

            // Random DCA amount (only in 40% of trades)
            const usedDCA = Math.random() > 0.6;
            const dcaAmount = usedDCA ? 0.1 + Math.random() * 0.4 : 0;

            // Record synthetic trade outcome
            this.recordTradeOutcome({
                initialPrice,
                exitPrice,
                buyAmount,
                sellAmount,
                takeProfit,
                stopLoss,
                profitLoss: priceChange,
                duration: Math.random() * 86400000, // Up to 24 hours
                success,
                dcaAmount
            });

            // Update current price for next iteration
            currentPrice = exitPrice;
        }

        console.log(`Added ${numSamples} synthetic trade records and 30 days of price history`);
        console.log(`Current metrics history size: ${this.metricsHistory.length}`);
        console.log(`Current price history size: ${this.priceHistory.length}`);

        // Force training if we have enough data
        if (this.metricsHistory.length >= 20) {
            this.trainModels();
        }

        return {
            metricsCount: this.metricsHistory.length,
            priceHistoryCount: this.priceHistory.length
        };
    }

    // Get current model statistics and training status
    getModelStats() {
        return {
            trained: this.metricsHistory.length >= 20,
            metricsCount: this.metricsHistory.length,
            priceHistoryCount: this.priceHistory.length,
            requiredForTraining: 20,
            modelFiles: {
                buyNet: fs.existsSync(path.join(path.resolve(__dirname, 'models'), 'buyNet.json')),
                sellNet: fs.existsSync(path.join(path.resolve(__dirname, 'models'), 'sellNet.json')),
                takeProfitNet: fs.existsSync(path.join(path.resolve(__dirname, 'models'), 'takeProfitNet.json')),
                stopLossNet: fs.existsSync(path.join(path.resolve(__dirname, 'models'), 'stopLossNet.json')),
                dcaNet: fs.existsSync(path.join(path.resolve(__dirname, 'models'), 'dcaNet.json'))
            }
        };
    }
}

module.exports = TradeStrategy;