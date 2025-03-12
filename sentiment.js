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
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;

if (!OPENAI_API_KEY) {
  console.error("WARNING: OPENAI_API_KEY not found in environment variables");
} else {
  console.log("OPENAI_API_KEY loaded successfully (length: " + OPENAI_API_KEY.length + ")");
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const detectAsset = async (query) => {
    try {
        const response = await axios.get("https://api.coingecko.com/api/v3/coins/list");
        const assets = response.data;
        
        console.log(`Detecting assets in query: "${query}"`);
        
        // Define major cryptocurrencies with their exact IDs from CoinGecko
        const majorCryptos = {
            'bitcoin': 'bitcoin',
            'btc': 'bitcoin',
            'ethereum': 'ethereum',
            'eth': 'ethereum',
            'solana': 'solana',
            'sol': 'solana',
            'cardano': 'cardano',
            'ada': 'cardano',
            'dogecoin': 'dogecoin',
            'doge': 'dogecoin',
            'ripple': 'ripple',
            'xrp': 'ripple',
            'binance coin': 'binancecoin',
            'bnb': 'binancecoin',
            'tether': 'tether',
            'usdt': 'tether',
            'polkadot': 'polkadot',
            'dot': 'polkadot',
            'avalanche': 'avalanche-2',
            'avax': 'avalanche-2',
            'shiba inu': 'shiba-inu',
            'shib': 'shiba-inu'
        };
        
        // Common words to ignore
        const commonWords = ['is', 'now', 'a', 'good', 'time', 'to', 'buy', 'sell', 'invest', 'in', 'the', 'and', 
                            'or', 'for', 'should', 'i', 'my', 'about', 'what', 'how', 'when', 'price', 'value', 
                            'which', 'better', 'worse', 'best', 'worst', 'crypto', 'cryptocurrency'];
        
        // Step 1: Check for major cryptocurrencies in the query
        const lowerQuery = query.toLowerCase();
        const foundMajorCryptos = [];
        
        for (const [cryptoName, cryptoId] of Object.entries(majorCryptos)) {
            // Check if the crypto name is mentioned as a whole word
            const regex = new RegExp(`\\b${cryptoName}\\b`, 'i');
            if (regex.test(lowerQuery)) {
                console.log(`Found major cryptocurrency: ${cryptoName} (ID: ${cryptoId})`);
                foundMajorCryptos.push(cryptoId);
            }
        }
        
        // If we found major cryptocurrencies, return the first one
        if (foundMajorCryptos.length > 0) {
            console.log(`Selecting ${foundMajorCryptos[0]} from found major cryptocurrencies`);
            return foundMajorCryptos[0];
        }
        
        // Step 2: If no major cryptos found, try to find any cryptocurrency by name or symbol
        // Split the query into words and filter out common words
        const queryWords = lowerQuery.split(/\s+/).filter(word => !commonWords.includes(word) && word.length > 2);
        
        for (const word of queryWords) {
            const exactMatch = assets.find(asset => 
                word === asset.name.toLowerCase() || 
                word === asset.symbol.toLowerCase()
            );
            
            if (exactMatch) {
                console.log(`Found exact match: ${exactMatch.name} (${exactMatch.symbol})`);
                return exactMatch.id;
            }
        }
        
        // Step 3: Default to bitcoin if no matches found
        console.log("No asset matches found, defaulting to bitcoin");
        return "bitcoin";
    } catch (error) {
        console.error("Error detecting asset:", error);
        return "bitcoin";
    }
};

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

const generateChartUrl = (priceData) => {
    const dataPoints = priceData.map(point => point[1]);
    return `https://quickchart.io/chart?c={type:'line',data:{labels:[1,2,3,4,5,6,7,8,9,10],datasets:[{label:'Price',data:[${dataPoints}]}]}}`;
};

const getTwitterSentiment = async (text) => {
    try {
        const response = await axios.post("https://api.koynlabs.com:3443/api/search", {
            query: text,
            limit: 50
        });
        
        if (response.data && response.data.data && response.data.data.items && Array.isArray(response.data.data.items)) {
            const tweets = response.data.data.items.map(item => `${item.title} ${item.description || ''}`.trim()).filter(text => text.length > 0);
            return tweets;
        }
        return [];
    } catch (error) {
        console.error("Error fetching tweets:", error);
        return [];
    }
};

const analyzeSentiment = (tweets) => {
    if (tweets.length === 0) return "Neutral";
    const sentiments = tweets.map(tweet => vader.SentimentIntensityAnalyzer.polarity_scores(tweet).compound);
    const avgSentiment = sentiments.reduce((a, b) => a + b, 0) / sentiments.length;
    return avgSentiment > 0.1 ? "Positive" : avgSentiment < -0.1 ? "Negative" : "Neutral";
};

const getOpenAIAnalysis = async (asset, assetPrice, sentiment, userQuery) => {
    try {
        const messages = [
            { role: "system", content: "You are a financial analyst. Provide insights based on asset price and social sentiment." },
            { role: "user", content: `${userQuery}\n\n${asset} is currently priced at $${assetPrice}. Social media sentiment is ${sentiment}. Should I invest?` }
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

app.use(express.json());

app.post("/api/sentiment", async (req, res) => {
    console.log("Received request:", req.body);
    const userQuery = req.body.question || "Is now a good time to buy crypto?";
    const asset = await detectAsset(userQuery);
        const assetPrice = await getAssetData(asset);
    const priceData = await getHistoricalData(asset);
    const priceChartUrl = generateChartUrl(priceData);
        const tweets = await getTwitterSentiment(asset);
        const sentiment = analyzeSentiment(tweets);

        if (assetPrice === "N/A") {
        return res.status(500).json({ error: `Failed to fetch ${asset} price` });
    }

    const openAIResponse = await getOpenAIAnalysis(asset, assetPrice, sentiment, userQuery);

    res.json({
                asset,
                asset_price: assetPrice,
        price_chart: priceChartUrl,
                social_sentiment: sentiment,
        analysis: openAIResponse,
        sources: [
            "https://coinmarketcap.com/",
            "https://www.coingecko.com/en/coins/bitcoin",
            "https://dexscreener.com/",
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
