require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const vader = require('vader-sentiment');
const https = require('https');
const fs = require('fs');
const { zodTextFormat } = require('openai/src/helpers/zod.js');
const xml2js = require('xml2js');

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

// let timestamp = Date.now();
// let hash = generateHash(profileId, timestamp);
// function generateHash(chatId, timestamp,) {
//   const data = `${chatId}:${timestamp}:${SECRET_KEY}`;
//   return crypto.createHash('sha256').update(data).digest('hex');
// }
// npm install axios xml2js

function stripHtmlAndDecodeEntities(html) {
    if (!html) return '';
    
    // First decode HTML entities
    let decoded = html.replace(/&lt;/g, '<')
                     .replace(/&gt;/g, '>')
                     .replace(/&amp;/g, '&')
                     .replace(/&quot;/g, '"')
                     .replace(/&#39;/g, "'")
                     .replace(/\[\[CDATA\[(.*?)\]\]>/g, '$1');
    
    // Then strip HTML tags
    return decoded.replace(/<[^>]*>/g, '')
                 .replace(/\s+/g, ' ')
                 .trim();
  }
  
  
  // Helper function to extract hashtags
  function extractHashtags(text) {
    if (!text) return [];
    const hashtagRegex = /#[\w\u0590-\u05ff]+/g;
    const matches = text.match(hashtagRegex);
    return matches ? [...new Set(matches)] : []; // Remove duplicates
  }

const detectAsset = async (query) => {
    try {
        const response = await axios.get("https://api.coingecko.com/api/v3/coins/list");
        const assets = response.data;
        const queryWords = query.toLowerCase().split(/\s+/);
        
        console.log(`Detecting assets in query: "${query}"`);
        
        // List of common English words to ignore
        const commonWords = ['is', 'now', 'a', 'good', 'time', 'to', 'buy', 'sell', 'invest', 'in', 'the', 'and', 'or', 'for', 'should', 'i', 'my', 'about', 'what', 'how', 'when', 'price', 'value'];
        
        // List of popular cryptocurrencies to prioritize
        const popularCryptos = [
            'bitcoin', 'btc', 
            'ethereum', 'eth', 
            'solana', 'sol', 
            'cardano', 'ada', 
            'dogecoin', 'doge', 
            'ripple', 'xrp', 
            'binance', 'bnb',
            'tether', 'usdt',
            'polkadot', 'dot',
            'avalanche', 'avax',
            'shiba', 'shib'
        ];
        
        // Step 1: First check if any popular crypto is mentioned directly
        for (const word of queryWords) {
            if (commonWords.includes(word)) continue; // Skip common words
            
            if (popularCryptos.includes(word)) {
                // Find the matching asset for this popular crypto
                const match = assets.find(asset => 
                    asset.name.toLowerCase() === word || 
                    asset.symbol.toLowerCase() === word
                );
                
                if (match) {
                    console.log(`Found popular crypto match: ${match.name} (${match.symbol})`);
                    return match.id;
                }
            }
        }
        
        // Step 2: Check for exact matches of non-common words
        for (const word of queryWords) {
            if (commonWords.includes(word) || word.length <= 2) continue; // Skip common words and very short words
            
            const exactMatch = assets.find(asset => 
                word === asset.name.toLowerCase() || 
                word === asset.symbol.toLowerCase()
            );
            
            if (exactMatch) {
                console.log(`Found exact match: ${exactMatch.name} (${exactMatch.symbol})`);
                return exactMatch.id;
            }
        }
        
        // Step 3: Check if the entire query contains mentions of popular cryptos
        for (const crypto of popularCryptos) {
            if (query.toLowerCase().includes(crypto)) {
                const match = assets.find(asset => 
                    asset.name.toLowerCase() === crypto || 
                    asset.symbol.toLowerCase() === crypto
                );
                
                if (match) {
                    console.log(`Found crypto in full query: ${match.name} (${match.symbol})`);
                    return match.id;
                }
            }
        }
        
        // Step 4: Default to bitcoin if no matches found
        console.log("No asset matches found, defaulting to bitcoin");
        return "bitcoin";
    } catch (error) {
        console.error("Error detecting asset:", error);
        return "bitcoin";
    }
};

const getFinancialNews = async (asset) => {
    try {
        // You can replace this with a real news API
        // Example using a hypothetical financial news API
        const response = await axios.get(`https://api.example.com/news`, {
            params: { q: asset, limit: 5 }
        });
        
        return response.data.articles.map(article => ({
            title: article.title,
            description: article.description,
            url: article.url,
            source: article.source.name,
            publishedAt: article.publishedAt
        }));
    } catch (error) {
        console.error(`Error fetching news for ${asset}:`, error);
        // Return some default news if the API fails
        return [
            {
                title: `Latest ${asset} Updates`,
                description: `Stay tuned for the latest ${asset} news and market analysis.`,
                url: `https://www.barrons.com/search?q=${asset}`,
                source: "Barron's",
                publishedAt: new Date().toISOString()
            },
            {
                title: `${asset} Market Trends`,
                description: `Analysis of current ${asset} market trends and future outlook.`,
                url: `https://www.investors.com/search/?q=${asset}`,
                source: "Investors.com",
                publishedAt: new Date().toISOString()
            },
            {
                title: `${asset} Investment Strategies`,
                description: `Expert recommendations on ${asset} investment strategies.`,
                url: `https://www.marketwatch.com/search?q=${asset}`,
                source: "MarketWatch",
                publishedAt: new Date().toISOString()
            }
        ];
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
            { 
                role: "user", 
                content: `${userQuery}\n\n${asset} is currently priced at $${assetPrice}. Social media sentiment is ${sentiment}. Should I invest?` +
                         "\n\nInclude relevant financial sources in your response using these placeholders: {{BARRONS}}, {{INVESTORS}}, {{MARKETWATCH}}."
            }
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
    const openAIResponse = await getOpenAIAnalysis(asset, assetPrice, sentiment, userQuery);

    // Get latest news headlines
    const financialNews = await getFinancialNews(asset);

    // Mapping placeholders to news sources
    const newsSources = {
        "{{BARRONS}}": `<span class="news-source" data-source="barrons">${financialNews[0]?.source || "Barron's"}</span>`,
        "{{INVESTORS}}": `<span class="news-source" data-source="investors">${financialNews[1]?.source || "Investors.com"}</span>`,
        "{{MARKETWATCH}}": `<span class="news-source" data-source="marketwatch">${financialNews[2]?.source || "MarketWatch"}</span>`
    };

    // Replace placeholders in OpenAI response with actual news source elements
    let formattedResponse = openAIResponse;
    Object.keys(newsSources).forEach(key => {
        formattedResponse = formattedResponse.replace(key, newsSources[key]);
    });

    res.json({
        question: userQuery,
        results: [
            {
                asset,
                asset_price: assetPrice,
                price_chart: priceChartUrl,
                social_sentiment: sentiment,
                analysis: formattedResponse
            }
        ],
        news: financialNews
    });
});


app.post('/api/profiles', async (req, res) => {
    const { profileId, timestamp, hash } = req.body;
  
    // Validate parameters
    if (!profileId) {
      return res.status(400).json({ 
        status: {
          code: 400,
          message: 'Missing profileId parameter'
        },
        data: null
      });
    }
  
    try {
      // Fetch RSS feed with profileId
      const response = await axios.get(`https://koynlabs.com/${profileId}/rss`);
      const parser = new xml2js.Parser({
        explicitArray: false,
        mergeAttrs: true
      });
  
      // Parse XML to JSON
      const result = await parser.parseStringPromise(response.data);
      
      // Transform the data structure and strip HTML
      const responseData = {
        status: {
          code: response.status,
          message: 'Success',
          timestamp: new Date().toISOString()
        },
        data: {
          metadata: {
            title: stripHtmlAndDecodeEntities(result.rss.channel.title),
            link: result.rss.channel.link,
            description: stripHtmlAndDecodeEntities(result.rss.channel.description),
            language: result.rss.channel.language,
            image: result.rss.channel.image
          },
          items: result.rss.channel.item.map(item => ({
            title: stripHtmlAndDecodeEntities(item.title),
            creator: stripHtmlAndDecodeEntities(item['dc:creator']),
            description: stripHtmlAndDecodeEntities(item.description),
            pubDate: item.pubDate,
            guid: item.guid,
            link: item.link
          }))
        }
      };
  
      res.json(responseData);
    } catch (error) {
      console.error('Error fetching or parsing RSS feed:', error);
      res.status(500).json({ 
        status: {
          code: error.response?.status || 500,
          message: 'Failed to fetch or parse RSS feed',
          error: error.message,
          timestamp: new Date().toISOString()
        },
        data: null
      });
    }
  });
  
  app.post('/api/search', async (req, res) => {
    const { query, timestamp, hash, limit = 20, page = 1 } = req.body;
  
    // Validate parameters
    if (!query) {
      return res.status(400).json({ 
        status: {
          code: 400,
          message: 'Missing search query parameter'
        },
        data: null
      });
    }
  
    try {
      // Calculate how many pages we need to fetch to reach the desired limit
      const pagesToFetch = Math.ceil(limit / 20);
      let allItems = [];
      let currentPage = 1;
  
      // Fetch RSS feed with search query for each page
      while (currentPage <= pagesToFetch) {
        const response = await axios.get(`https://koynlabs.com/search/rss`, {
          params: {
            f: 'tweets',
            q: query,
            p: currentPage // Add page parameter
          }
        });
        
        const parser = new xml2js.Parser({
          explicitArray: false,
          mergeAttrs: true
        });
  
        // Parse XML to JSON
        const result = await parser.parseStringPromise(response.data);
        
        // Add items from this page to our collection
        if (result.rss.channel.item) {
          const items = Array.isArray(result.rss.channel.item) ? 
            result.rss.channel.item : [result.rss.channel.item];
          allItems = allItems.concat(items);
        }
  
        currentPage++;
  
        // If we've collected enough items, stop fetching more pages
        if (allItems.length >= limit) {
          break;
        }
      }
  
      // Trim to exact limit if we got more items than requested
      allItems = allItems.slice(0, limit);
      
      // Transform the data structure and strip HTML
      const responseData = {
        status: {
          code: 200,
          message: 'Success',
          timestamp: new Date().toISOString(),
          query,
          limit,
          totalResults: allItems.length,
          page
        },
        data: {
          metadata: {
            title: `Search results for "${query}"`,
            link: `https://koynlabs.com/search?q=${encodeURIComponent(query)}`,
            description: `Search results for "${query}"`,
            language: "en-us"
          },
          items: allItems.map(item => ({
            title: stripHtmlAndDecodeEntities(item.title),
            creator: stripHtmlAndDecodeEntities(item['dc:creator']),
            description: stripHtmlAndDecodeEntities(item.description),
            pubDate: item.pubDate,
            guid: item.guid,
            link: item.link,
            hashtags: extractHashtags(item.description + ' ' + item.title)
          }))
        }
      };
  
      res.json(responseData);
    } catch (error) {
      console.error('Error fetching or parsing RSS feed:', error);
      res.status(500).json({ 
        status: {
          code: error.response?.status || 500,
          message: 'Failed to fetch or parse RSS feed',
          error: error.message,
          timestamp: new Date().toISOString(),
          query
        },
        data: null
      });
    }
  });

const options = {
  key: fs.readFileSync(SSL_KEY_PATH),
  cert: fs.readFileSync(SSL_CERT_PATH)
};
const server = https.createServer(options, app);
server.listen(PORT, () => console.log(`HTTPS server running on port ${PORT}`));
