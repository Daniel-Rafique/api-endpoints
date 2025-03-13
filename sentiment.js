require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const vader = require('vader-sentiment');
const https = require('https');
const fs = require('fs');
// const { zodTextFormat } = require('openai/src/helpers/zod.js');
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
            'binance': 'binancecoin',
            'bnb': 'binancecoin',
            'tether': 'tether',
            'usdt': 'tether',
            'polkadot': 'polkadot',
            'dot': 'polkadot',
            'avalanche': 'avalanche-2',
            'avax': 'avalanche-2',
            'shiba': 'shiba-inu',
            'shib': 'shiba-inu'
        };
        
        // Common words to ignore
        const commonWords = ['is', 'now', 'a', 'good', 'time', 'to', 'buy', 'sell', 'invest', 'in', 'the', 'and', 
                            'or', 'for', 'should', 'i', 'my', 'about', 'what', 'how', 'when', 'price', 'value', 
                            'which', 'better', 'worse', 'best', 'worst', 'crypto', 'cryptocurrency'];
        
        // Check for comparison queries (e.g., "Which is better, Bitcoin or Ethereum?")
        if (query.toLowerCase().includes('better') || 
            query.toLowerCase().includes('versus') || 
            query.toLowerCase().includes('vs') || 
            query.toLowerCase().includes('compare') || 
            query.toLowerCase().includes('comparison')) {
            
            // Look for major cryptocurrencies in the query
            for (const [cryptoName, cryptoId] of Object.entries(majorCryptos)) {
                // Use word boundary to match whole words only
                const regex = new RegExp(`\\b${cryptoName}\\b`, 'i');
                if (regex.test(query.toLowerCase())) {
                    console.log(`Found major cryptocurrency in comparison query: ${cryptoName} (ID: ${cryptoId})`);
                    return cryptoId;
                }
            }
        }
        
        // Split query into words and filter out common words
        const queryWords = query.toLowerCase().split(/\s+/).filter(word => !commonWords.includes(word));
        
        // Step 1: First check for exact matches of major cryptocurrencies
        for (const word of queryWords) {
            if (majorCryptos[word]) {
                console.log(`Found exact match for major cryptocurrency: ${word} (ID: ${majorCryptos[word]})`);
                return majorCryptos[word];
            }
        }
        
        // Step 2: Check for partial matches in major cryptocurrencies
        // This is useful for queries like "bit" or "eth"
        for (const word of queryWords) {
            if (word.length < 3) continue; // Skip very short words
            
            for (const [cryptoName, cryptoId] of Object.entries(majorCryptos)) {
                if (cryptoName.startsWith(word) || word.startsWith(cryptoName)) {
                    console.log(`Found partial match for major cryptocurrency: ${word} matches ${cryptoName} (ID: ${cryptoId})`);
                    return cryptoId;
                }
            }
        }
        
        // Step 3: Check for exact matches in the full CoinGecko list
        // But only for top 100 coins by market cap to avoid scams
        const top100Coins = assets.filter(asset => 
            // This is a heuristic - legitimate coins usually have shorter IDs
            asset.id.length < 15 && 
            !asset.id.includes('test') && 
            !asset.id.includes('scam') &&
            !asset.id.includes('fake')
        ).slice(0, 100);
        
        for (const word of queryWords) {
            if (word.length < 3) continue; // Skip very short words
            
            const exactMatch = top100Coins.find(asset => 
                word === asset.name.toLowerCase() || 
                word === asset.symbol.toLowerCase()
            );
            
            if (exactMatch) {
                console.log(`Found exact match in top coins: ${exactMatch.name} (${exactMatch.symbol})`);
                return exactMatch.id;
            }
        }
        
        // Step 4: Check if the entire query contains mentions of major cryptos
        for (const [cryptoName, cryptoId] of Object.entries(majorCryptos)) {
            if (query.toLowerCase().includes(cryptoName)) {
                console.log(`Found major cryptocurrency in full query: ${cryptoName} (ID: ${cryptoId})`);
                return cryptoId;
            }
        }
        
        // Step 5: Default to bitcoin if no matches found
        console.log("No reliable asset matches found, defaulting to bitcoin");
        return "bitcoin";
    } catch (error) {
        console.error("Error detecting asset:", error);
        return "bitcoin";
    }
};

const getFinancialNews = async (query) => {
    try {
        // Fetch news related to the query
        const response = await axios.get(`https://newsapi.org/v2/everything`, {
            params: {
                q: query,
                apiKey: process.env.NEWS_API_KEY,
                language: "en",
                sortBy: "publishedAt"
            }
        });

        if (!response.data.articles || response.data.articles.length === 0) {
            throw new Error("No articles found, falling back...");
        }

        return response.data.articles.slice(0, 5).map(article => ({
            title: article.title,
            url: article.url,
            source: article.source.name,
            description: article.description || "No description available.",
            publishedAt: article.publishedAt
        }));
    } catch (error) {
        console.error("Error fetching financial news:", error.message);

        // Fallback: Use general finance-related terms
        try {
            const fallbackResponse = await axios.get(`https://newsapi.org/v2/everything`, {
                params: {
                    q: `${query} finance OR investing OR market`,
                    apiKey: process.env.NEWS_API_KEY,
                    language: "en",
                    sortBy: "relevancy"
                }
            });

            if (!fallbackResponse.data.articles || fallbackResponse.data.articles.length === 0) {
                throw new Error("No fallback articles found.");
            }

            return fallbackResponse.data.articles.slice(0, 5).map(article => ({
                title: article.title,
                url: article.url,
                source: article.source.name,
                description: article.description || "No description available.",
                publishedAt: article.publishedAt
            }));
        } catch (fallbackError) {
            console.error("Error fetching fallback news:", fallbackError.message);

            // If both fail, return mock data
            return [
                {
                    title: `Latest ${query} Updates`,
                    url: `https://www.barrons.com/search?q=${query}`,
                    source: "Barron's",
                    description: `Stay updated on the latest ${query} news and market analysis.`,
                    publishedAt: new Date().toISOString()
                },
                {
                    title: `${query} Market Trends`,
                    url: `https://www.marketwatch.com/search?q=${query}`,
                    source: "MarketWatch",
                    description: `Analysis of current ${query} market trends and future outlook.`,
                    publishedAt: new Date().toISOString()
                },
                {
                    title: `${query} Investment Strategies`,
                    url: `https://www.investors.com/search/?q=${query}`,
                    source: "Investors.com",
                    description: `Expert recommendations on ${query} investment strategies.`,
                    publishedAt: new Date().toISOString()
                }
            ];
        }
    }
};


// const getFinancialNews = async (query) => {
//     try {
//         // First, try with domains instead of sources
//         const response = await axios.get(`https://newsapi.org/v2/everything`, {
//             params: {
//                 q: query,
//                 apiKey: process.env.NEWS_API_KEY,
//                 language: "en",
//                 domains: "barrons.com,marketwatch.com,investors.com",
//                 sortBy: "publishedAt"
//             }
//         });

//         return response.data.articles.slice(0, 5).map(article => ({
//             title: article.title,
//             url: article.url,
//             source: article.source.name,
//             description: article.description,
//             publishedAt: article.publishedAt
//         }));
//     } catch (error) {
//         console.error("Error fetching financial news:", error);
        
//         // Fallback to a more general query without specific sources
//         try {
//             const fallbackResponse = await axios.get(`https://newsapi.org/v2/everything`, {
//                 params: {
//                     q: `${query} finance OR investing OR market`,
//                     apiKey: process.env.NEWS_API_KEY,
//                     language: "en",
//                     sortBy: "relevancy"
//                 }
//             });
            
//             return fallbackResponse.data.articles.slice(0, 5).map(article => ({
//                 title: article.title,
//                 url: article.url,
//                 source: article.source.name,
//                 description: article.description,
//                 publishedAt: article.publishedAt
//             }));
//         } catch (fallbackError) {
//             console.error("Error fetching fallback news:", fallbackError);
            
//             // Return mock data if all else fails
//             return [
//                 {
//                     title: `Latest ${query} Updates`,
//                     url: `https://www.barrons.com/search?q=${query}`,
//                     source: "Barron's",
//                     description: `Stay updated on the latest ${query} news and market analysis.`,
//                     publishedAt: new Date().toISOString()
//                 },
//                 {
//                     title: `${query} Market Trends`,
//                     url: `https://www.marketwatch.com/search?q=${query}`,
//                     source: "MarketWatch",
//                     description: `Analysis of current ${query} market trends and future outlook.`,
//                     publishedAt: new Date().toISOString()
//                 },
//                 {
//                     title: `${query} Investment Strategies`,
//                     url: `https://www.investors.com/search/?q=${query}`,
//                     source: "Investors.com",
//                     description: `Expert recommendations on ${query} investment strategies.`,
//                     publishedAt: new Date().toISOString()
//                 }
//             ];
//         }
//     }
// };

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
        const response = await axios.post("https://api.koynlabs.com:3003/api/search", {
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

// Add CORS headers to allow requests from your frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

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
