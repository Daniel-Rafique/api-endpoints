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

// Check if API key is loaded
if (!OPENAI_API_KEY) {
  console.error("WARNING: OPENAI_API_KEY not found in environment variables");
  console.log("Make sure your .env file is in the correct location and contains OPENAI_API_KEY");
} else {
  console.log("OPENAI_API_KEY loaded successfully (length: " + OPENAI_API_KEY.length + ")");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

// Function to fetch Bitcoin price from CoinGecko
const getAssetData = async (asset) => {
    let price = await getDexScreenerData(asset);

    if (price === "N/A") {
        try {
            const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
                params: { ids: asset.toLowerCase(), vs_currencies: "usd" }
            });
            price = response.data[asset.toLowerCase()]?.usd || "N/A";
        } catch (error) {
            console.error(`Error fetching ${asset} price from CoinGecko:`, error);
            price = "N/A";
        }
    }

    return price;
};


// Function to fetch recent tweets about Bitcoin
const getTwitterSentiment = async (text) => {
    try {
        const response = await axios.get("https://api.koynlabs.com:3443/api/search", {
            params: { query: text, limit: 50 }
        });
        return response.data.data?.map(tweet => tweet.text) || [];
    } catch (error) {
        console.error("Error fetching tweets:", error);
        return [];
    }
};

// Function to analyze sentiment of tweets using VADER
const analyzeSentiment = (tweets) => {
    if (tweets.length === 0) return "Neutral";

    const sentiments = tweets.map(tweet => vader.SentimentAnalyzer.polarity_scores(tweet).compound);
    const avgSentiment = sentiments.reduce((a, b) => a + b, 0) / sentiments.length;

    return avgSentiment > 0.1 ? "Positive" : avgSentiment < -0.1 ? "Negative" : "Neutral";
};

// Function to get a conversational financial analysis from OpenAI
const getOpenAIAnalysis = async (asset, assetPrice, sentiment, userQuestion) => {
    try {
        const messages = [
            { role: "system", content: "You are a friendly and knowledgeable financial analyst. You provide clear and engaging insights on asset prices and social sentiment. Keep it conversational and insightful." },
            { role: "user", content: `${userQuestion}\n\nFor context: ${asset} is currently priced at $${assetPrice}. The latest social media sentiment is ${sentiment}.` }
        ];

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages,
            temperature: 0.7 // More creativity in responses
        });

        return response.choices[0].message.content;
    } catch (error) {
        console.error("Error fetching OpenAI response:", error);
        return "Hmm, I couldn't analyze that right now. Try again in a moment!";
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

app.post("/api/sentiment", async (req, res) => {
    console.log("Received request body:", JSON.stringify(req.body));
    
    const userQuestion = req.body.question || "Is now a good time to buy crypto?";
    let assets = req.body.assets || ["bitcoin", "ethereum", "solana", "dogecoin", "shiba-inu", "cardano", "polkadot", "avalanche", "matic-network", "uniswap", "xrp"]; // Default to major cryptos

    console.log(`Processing request with question: "${userQuestion}" and assets:`, assets);
    let results = [];

    for (const asset of assets) {
        console.log(`Processing asset: ${asset}`);
        const assetPrice = await getAssetData(asset);
        console.log(`${asset} price: ${assetPrice}`);
        const tweets = await getTwitterSentiment(asset);
        console.log(`Retrieved ${tweets.length} tweets for ${asset}`);
        const sentiment = analyzeSentiment(tweets);
        console.log(`${asset} sentiment: ${sentiment}`);

        if (assetPrice === "N/A") {
            console.log(`Skipping ${asset} due to missing price data`);
            continue; // Skip assets with no price data
        }

        try {
            const openAIResponse = await getOpenAIAnalysis(asset, assetPrice, sentiment, userQuestion);
            console.log(`Got OpenAI analysis for ${asset}`);

            results.push({
                asset,
                asset_price: assetPrice,
                social_sentiment: sentiment,
                analysis: openAIResponse
            });
        } catch (error) {
            console.error(`Error getting OpenAI analysis for ${asset}:`, error);
            // Continue with other assets even if one fails
        }
    }

    if (results.length === 0) {
        console.log("No results found for any assets");
        return res.status(500).json({ error: "No financial data available." });
    }

    console.log(`Returning results for ${results.length} assets`);
    res.json({ question: userQuestion, results });
});

// Add a GET endpoint that mirrors the POST functionality
app.get("/api/sentiment", async (req, res) => {
    const userQuestion = req.query.question || "Is now a good time to buy crypto?";
    let assets = req.query.assets ? req.query.assets.split(',') : ["bitcoin", "ethereum"];
    
    console.log(`Processing GET request with question: "${userQuestion}" and assets:`, assets);
    let results = [];
    
    try {
        // Process just one asset for GET requests to keep it fast
        const asset = assets[0];
        console.log(`Processing asset: ${asset}`);
        const assetPrice = await getAssetData(asset);
        console.log(`${asset} price: ${assetPrice}`);
        const tweets = await getTwitterSentiment(asset);
        console.log(`Retrieved ${tweets.length} tweets for ${asset}`);
        const sentiment = analyzeSentiment(tweets);
        console.log(`${asset} sentiment: ${sentiment}`);
        
        if (assetPrice !== "N/A") {
            const openAIResponse = await getOpenAIAnalysis(asset, assetPrice, sentiment, userQuestion);
            console.log(`Got OpenAI analysis for ${asset}`);
            
            results.push({
                asset,
                asset_price: assetPrice,
                social_sentiment: sentiment,
                analysis: openAIResponse
            });
        }
        
        if (results.length === 0) {
            console.log("No results found for any assets");
            return res.status(500).json({ error: "No financial data available." });
        }
        
        console.log(`Returning results for ${results.length} assets`);
        res.json({ question: userQuestion, results });
    } catch (error) {
        console.error("Error processing GET request:", error);
        res.status(500).json({ error: "An error occurred while processing your request", message: error.message });
    }
});

const options = {
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH)
};
const server = https.createServer(options, app);
server.listen(PORT, () => console.log(`HTTPS server running on port ${PORT}`));
