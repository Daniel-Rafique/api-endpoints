require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const vader = require('vader-sentiment');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = 3003;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Load environment variables for SSL
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
// Check if API key is loaded
if (!OPENAI_API_KEY) {
  console.error("WARNING: OPENAI_API_KEY not found in environment variables");
  console.log("Make sure your .env file is in the correct location and contains OPENAI_API_KEY");
} else {
  console.log("OPENAI_API_KEY loaded successfully (length: " + OPENAI_API_KEY.length + ")");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Function to detect crypto asset from user query
const detectAsset = async (query) => {
    try {
        const response = await axios.get("https://api.coingecko.com/api/v3/coins/list");
        const assets = response.data;
        const foundAsset = assets.find(asset => query.toLowerCase().includes(asset.name.toLowerCase()) || query.toLowerCase().includes(asset.symbol.toLowerCase()));
        return foundAsset ? foundAsset.id : "bitcoin";
    } catch (error) {
        console.error("Error detecting asset:", error);
        return "bitcoin";
    }
};

const getDexScreenerData = async (asset) => {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/search?q=${asset}`);
        const pairs = response.data.pairs;

        if (pairs && pairs.length > 0) {
            return pairs[0].priceUsd || "N/A";  // Return the first available price
        }
        return "N/A";
    } catch (error) {
        console.error(`Error fetching ${asset} price from DexScreener:`, error);
        return "N/A";
    }
};

// Function to fetch asset price from CoinGecko
const getAssetData = async (asset) => {
    try {
        const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
            params: { ids: asset.toLowerCase(), vs_currencies: "usd" }
        });
        return response.data[asset.toLowerCase()]?.usd || "N/A";
    } catch (error) {
        console.error(`Error fetching ${asset} price:`, error);
        return "N/A";
    }
};

// Function to fetch historical price data
const getHistoricalData = async (asset) => {
    try {
        const response = await axios.get(`https://api.coingecko.com/api/v3/coins/${asset}/market_chart`, {
            params: { vs_currency: "usd", days: "1" }
        });
        return response.data.prices;
    } catch (error) {
        console.error("Error fetching historical data:", error);
        return [];
    }
};

// Function to generate a price chart URL
const generateChartUrl = (priceData) => {
    const dataPoints = priceData.map(point => point[1]);
    return `https://quickchart.io/chart?c={type:'line',data:{labels:[1,2,3,4,5,6,7,8,9,10],datasets:[{label:'Price',data:[${dataPoints}]}]}}`;
};

// Function to fetch recent tweets about Bitcoin
const getTwitterSentiment = async (text) => {
    try {
        const response = await axios.post("https://api.koynlabs.com:3443/api/search", {
            query: text,
            limit: 50
        });
        
        // Check if the response has the expected structure
        if (response.data && response.data.data && response.data.data.items && Array.isArray(response.data.data.items)) {
            console.log(`Found ${response.data.data.items.length} tweets for analysis`);
            
            // Extract both title and description from each item for better sentiment analysis
            const tweets = response.data.data.items.map(item => {
                // Combine title and description for more context, but avoid duplication
                let text = "";
                
                if (item.title) {
                    text += item.title;
                }
                
                if (item.description && item.description !== item.title) {
                    if (text) text += " ";
                    text += item.description;
                }
                
                return text;
            }).filter(text => text.trim().length > 0); // Remove empty texts
            
            console.log(`Extracted ${tweets.length} non-empty tweet texts`);
            return tweets;
        } else {
            console.error("Unexpected response structure:", JSON.stringify(response.data).substring(0, 200) + "...");
            return [];
        }
    } catch (error) {
        console.error("Error fetching tweets:", error);
        console.error("Error details:", error.response?.data || error.message);
        return [];
    }
};

// Function to analyze sentiment of tweets using VADER
const analyzeSentiment = (tweets) => {
    if (tweets.length === 0) return "Neutral";
    
    // Calculate sentiment for each tweet
    const sentiments = tweets.map(tweet => {
        try {
            // The correct way to use vader-sentiment
            const scores = vader.SentimentIntensityAnalyzer.polarity_scores(tweet);
            return scores.compound;
        } catch (error) {
            console.error(`Error analyzing tweet: "${tweet.substring(0, 50)}..."`, error);
            return 0; // Neutral score for tweets that can't be analyzed
        }
    });
    
    const avgSentiment = sentiments.reduce((a, b) => a + b, 0) / sentiments.length;

    return avgSentiment > 0.1 ? "Positive" : avgSentiment < -0.1 ? "Negative" : "Neutral";
};

// Function to get financial analysis from OpenAI
const getOpenAIAnalysis = async (asset, assetPrice, sentiment) => {
    try {
        const messages = [
            { role: "system", content: "You are a financial analyst. Provide insights based on asset price and social sentiment." },
            { role: "user", content: `${asset} is currently priced at $${assetPrice}. Social media sentiment is ${sentiment}. Should I invest?` }
        ];

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages
        });

        return response.choices[0].message.content;
    } catch (error) {
        console.error("Error fetching OpenAI response:", error);
        return "Unable to retrieve analysis.";
    }
};


// API Endpoint: Returns asset price, sentiment, and OpenAI analysis based on user query
app.use(express.json()); // Enable JSON parsing for POST requests

// Add CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error('Error in request:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Add a simple GET endpoint for testing
app.get("/api/sentiment/test", (req, res) => {
  res.json({ status: "ok", message: "Sentiment API is running" });
});

// API Endpoint: Returns asset price, sentiment, price chart, and OpenAI analysis
app.post("/api/sentiment", async (req, res) => {
    console.log("Received request:", req.body);
    const userQuery = req.body.query || "";
    const asset = await detectAsset(userQuery);
    const assetPrice = await getAssetData(asset);
    const priceData = await getHistoricalData(asset);
    const priceChartUrl = generateChartUrl(priceData);
    const tweets = await getTwitterSentiment(asset);
    const sentiment = analyzeSentiment(tweets);

    if (assetPrice === "N/A") {
        return res.status(500).json({ error: `Failed to fetch ${asset} price` });
    }

    const openAIResponse = await getOpenAIAnalysis(asset, assetPrice, sentiment);

    res.json({
        asset: asset,
        asset_price: assetPrice,
        price_chart: priceChartUrl,
        social_sentiment: sentiment,
        analysis: openAIResponse,
        sources: [
            "https://coinmarketcap.com/",
            "https://www.marketwatch.com",
            "https://www.barrons.com"
        ]
    });
});

const options = {
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH)
};
const server = https.createServer(options, app);
server.listen(PORT, () => console.log(`HTTPS server running on port ${PORT}`));
