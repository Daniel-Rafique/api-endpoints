require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const vader = require('vader-sentiment');

const app = express();
const PORT = 3003;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
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

app.post("/api/sentiment", async (req, res) => {
    const userQuestion = req.body.question || "Is now a good time to buy crypto?";
    let assets = req.body.assets || ["bitcoin", "ethereum", "solana", "dogecoin", "shiba-inu", "cardano", "polkadot", "avalanche", "matic-network", "uniswap", "xrp"]; // Default to major cryptos

    let results = [];

    for (const asset of assets) {
        const assetPrice = await getAssetData(asset);
        const tweets = await getTwitterSentiment(asset);
        const sentiment = analyzeSentiment(tweets);

        if (assetPrice === "N/A") {
            continue; // Skip assets with no price data
        }

        const openAIResponse = await getOpenAIAnalysis(asset, assetPrice, sentiment, userQuestion);

        results.push({
            asset,
            asset_price: assetPrice,
            social_sentiment: sentiment,
            analysis: openAIResponse
        });
    }

    if (results.length === 0) {
        return res.status(500).json({ error: "No financial data available." });
    }

    res.json({ question: userQuestion, results });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
