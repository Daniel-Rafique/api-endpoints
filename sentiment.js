require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const vader = require('vader-sentiment');
const https = require('https');
const fs = require('fs');
const path = require('path');
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

const loadCryptoData = () => {
  try {
    const cryptoDataPath = path.join(__dirname, 'assetDetection', 'cryptoData', 'latest100.json');
    const rawData = fs.readFileSync(cryptoDataPath, 'utf8');
    const cryptoData = JSON.parse(rawData);
    
    // Transform the data into a more usable format for asset detection
    const cryptoMap = {};
    
    cryptoData.data.constituents.forEach(crypto => {
      // Add by name (lowercase for case-insensitive matching)
      cryptoMap[crypto.name.toLowerCase()] = {
        id: crypto.id.toString(),
        name: crypto.name,
        symbol: crypto.symbol,
        type: 'crypto',
        url: crypto.url,
        weight: crypto.weight
      };
      
      // Also add by symbol for easier matching
      cryptoMap[crypto.symbol.toLowerCase()] = {
        id: crypto.id.toString(),
        name: crypto.name,
        symbol: crypto.symbol,
        type: 'crypto',
        url: crypto.url,
        weight: crypto.weight
      };
    });
    
    return cryptoMap;
  } catch (error) {
    console.error("Error loading crypto data:", error);
    return {};
  }
};

// Load FX, indices, and commodities data
const loadMarketData = () => {
  try {
    const marketDataPath = path.join(__dirname, 'assetDetection', 'latest100.json');
    const rawData = fs.readFileSync(marketDataPath, 'utf8');
    const marketData = JSON.parse(rawData);
    
    // Create a unified map for easier lookup
    const assetMap = {};
    
    // Process FX pairs
    marketData.fx_pairs.forEach(pair => {
      // Add by ID
      assetMap[pair.id.toLowerCase()] = pair;
      
      // Add by symbol
      assetMap[pair.symbol.toLowerCase()] = pair;
      
      // Add by name
      assetMap[pair.name.toLowerCase()] = pair;
      
      // Add by individual currencies
      assetMap[pair.base.toLowerCase()] = {
        ...pair,
        name: getCurrencyName(pair.base)
      };
      
      assetMap[pair.quote.toLowerCase()] = {
        ...pair,
        name: getCurrencyName(pair.quote)
      };
    });
    
    // Process indices
    marketData.indices.forEach(index => {
      // Add by ID
      assetMap[index.id.toLowerCase()] = index;
      
      // Add by symbol
      assetMap[index.symbol.toLowerCase()] = index;
      
      // Add by name
      assetMap[index.name.toLowerCase()] = index;
      
      // Add common variations
      if (index.name.includes('&')) {
        const simplifiedName = index.name.replace('&', 'and').toLowerCase();
        assetMap[simplifiedName] = index;
      }
    });
    
    // Process commodities
    marketData.commodities.forEach(commodity => {
      // Add by ID
      assetMap[commodity.id.toLowerCase()] = commodity;
      
      // Add by symbol
      assetMap[commodity.symbol.toLowerCase()] = commodity;
      
      // Add by name
      assetMap[commodity.name.toLowerCase()] = commodity;
      
      // Add common variations (e.g., "Crude Oil" for "Crude Oil WTI")
      if (commodity.name.includes(' ')) {
        const parts = commodity.name.split(' ');
        if (parts.length > 1) {
          const simplifiedName = parts.slice(0, 2).join(' ').toLowerCase();
          if (simplifiedName.length > 3 && !assetMap[simplifiedName]) {
            assetMap[simplifiedName] = commodity;
          }
        }
      }
    });
    
    return assetMap;
  } catch (error) {
    console.error("Error loading market data:", error);
    return {};
  }
};

// Helper function to get full currency names
function getCurrencyName(code) {
  const currencyNames = {
    'USD': 'US Dollar',
    'EUR': 'Euro',
    'JPY': 'Japanese Yen',
    'GBP': 'British Pound',
    'AUD': 'Australian Dollar',
    'CAD': 'Canadian Dollar',
    'CHF': 'Swiss Franc',
    'CNY': 'Chinese Yuan',
    'HKD': 'Hong Kong Dollar',
    'NZD': 'New Zealand Dollar',
    'SEK': 'Swedish Krona',
    'SGD': 'Singapore Dollar',
    'NOK': 'Norwegian Krone',
    'MXN': 'Mexican Peso',
    'INR': 'Indian Rupee',
    'BRL': 'Brazilian Real',
    'ZAR': 'South African Rand',
    'RUB': 'Russian Ruble',
    'TRY': 'Turkish Lira'
  };
  
  return currencyNames[code] || `${code} Currency`;
}

// Map of stock tickers to company names
// This is needed because your CSV only contains tickers, not company names
const stockTickerToName = {
  'AAPL': 'Apple Inc.',
  'MSFT': 'Microsoft Corporation',
  'AMZN': 'Amazon.com Inc.',
  'GOOGL': 'Alphabet Inc. (Google) Class A',
  'GOOG': 'Alphabet Inc. (Google) Class C',
  'META': 'Meta Platforms Inc.',
  'TSLA': 'Tesla Inc.',
  'NVDA': 'NVIDIA Corporation',
  'BRK.B': 'Berkshire Hathaway Inc.',
  'JPM': 'JPMorgan Chase & Co.',
  'JNJ': 'Johnson & Johnson',
  'V': 'Visa Inc.',
  'UNH': 'UnitedHealth Group Inc.',
  'HD': 'Home Depot Inc.',
  'PG': 'Procter & Gamble Co.',
  'BAC': 'Bank of America Corp.',
  'MA': 'Mastercard Inc.',
  'XOM': 'Exxon Mobil Corporation',
  'AVGO': 'Broadcom Inc.',
  'CVX': 'Chevron Corporation',
  'ABBV': 'AbbVie Inc.',
  'COST': 'Costco Wholesale Corporation',
  'PFE': 'Pfizer Inc.',
  'CSCO': 'Cisco Systems Inc.',
  'TMO': 'Thermo Fisher Scientific Inc.',
  'MRK': 'Merck & Co. Inc.',
  'LLY': 'Eli Lilly and Company',
  'ABT': 'Abbott Laboratories',
  'CRM': 'Salesforce Inc.',
  'ADBE': 'Adobe Inc.',
  'WMT': 'Walmart Inc.',
  'ACN': 'Accenture plc',
  'DIS': 'The Walt Disney Company',
  'KO': 'The Coca-Cola Company',
  'PEP': 'PepsiCo Inc.',
  'VZ': 'Verizon Communications Inc.',
  'CMCSA': 'Comcast Corporation',
  'NFLX': 'Netflix Inc.',
  'NKE': 'Nike Inc.',
  'INTC': 'Intel Corporation',
  'T': 'AT&T Inc.',
  'WFC': 'Wells Fargo & Company',
  'TXN': 'Texas Instruments Inc.',
  'AMD': 'Advanced Micro Devices Inc.',
  'QCOM': 'Qualcomm Inc.',
  'IBM': 'International Business Machines Corporation',
  'PYPL': 'PayPal Holdings Inc.',
  'TMUS': 'T-Mobile US Inc.',
  'GS': 'Goldman Sachs Group Inc.',
  'SBUX': 'Starbucks Corporation',
  'MS': 'Morgan Stanley',
  'C': 'Citigroup Inc.',
  'AMGN': 'Amgen Inc.',
  'RTX': 'Raytheon Technologies Corporation',
  'ORCL': 'Oracle Corporation',
  'CAT': 'Caterpillar Inc.',
  'HON': 'Honeywell International Inc.',
  'UPS': 'United Parcel Service Inc.',
  'LOW': 'Lowe\'s Companies Inc.',
  'AXP': 'American Express Company',
  'BA': 'Boeing Company',
  'BLK': 'BlackRock Inc.',
  'GILD': 'Gilead Sciences Inc.',
  'MMM': 'Minnesota Mining and Manufacturing Company',
  'MDLZ': 'Mondelez International Inc.',
  'PM': 'Philip Morris International Inc.',
  'F': 'Ford Motor Company',
  'GM': 'General Motors Company',
  'USB': 'U.S. Bancorp',
  'BKNG': 'Booking Holdings Inc.',
  'CVS': 'CVS Health Corporation',
  'MO': 'Altria Group Inc.',
  'MDT': 'Medtronic plc',
  'BMY': 'Bristol-Myers Squibb Company',
  'COP': 'ConocoPhillips',
  'CHTR': 'Charter Communications Inc.',
  'TGT': 'Target Corporation',
  'AMT': 'American Tower Corporation',
  'SPGI': 'S&P Global Inc.',
  'MCD': 'McDonald\'s Corporation',
  'DHR': 'Danaher Corporation',
  'UNP': 'Union Pacific Corporation',
  'NEE': 'NextEra Energy Inc.',
  'LIN': 'Linde plc',
  'FDX': 'FedEx Corporation',
  'GE': 'General Electric Company',
  'AIG': 'American International Group Inc.',
  'BIIB': 'Biogen Inc.',
  'SO': 'Southern Company',
  'DOW': 'Dow Inc.',
  'DUK': 'Duke Energy Corporation',
  'KHC': 'The Kraft Heinz Company',
  'SPG': 'Simon Property Group Inc.',
  'EMR': 'Emerson Electric Co.',
  'EXC': 'Exelon Corporation',
  'DD': 'DuPont de Nemours Inc.',
  'MET': 'MetLife Inc.',
  'BK': 'The Bank of New York Mellon Corporation'
};

// Load stock data from CSV
const loadStockData = () => {
  return new Promise((resolve, reject) => {
    try {
      const stockDataPath = path.join(__dirname, 'assetDetection', 'stocksData', 'latest100.csv');
      const stockMap = {};
      const tickers = [];
      
      // First pass: extract header row to get all ticker symbols
      const firstLine = fs.readFileSync(stockDataPath, 'utf8').split('\n')[0];
      const headers = firstLine.split(',');
      
      // Skip the first column (Date) and process all ticker symbols
      for (let i = 1; i < headers.length; i++) {
        const ticker = headers[i].trim();
        tickers.push(ticker);
        
        // Create entries for both ticker and company name (if available)
        const companyName = stockTickerToName[ticker] || `${ticker} Stock`;
        
        stockMap[ticker.toLowerCase()] = {
          id: ticker,
          name: companyName,
          symbol: ticker,
          type: 'stock'
        };
        
        // Also add by company name for easier matching
        if (companyName) {
          stockMap[companyName.toLowerCase()] = {
            id: ticker,
            name: companyName,
            symbol: ticker,
            type: 'stock'
          };
          
          // Add common variations (without "Inc.", "Corporation", etc.)
          const simplifiedName = companyName
            .replace(/ Inc\.?$| Corporation$| Corp\.?$| Co\.?$| Company$| plc$| Ltd\.?$/i, '')
            .toLowerCase();
          
          if (simplifiedName !== companyName.toLowerCase()) {
            stockMap[simplifiedName] = {
              id: ticker,
              name: companyName,
              symbol: ticker,
              type: 'stock'
            };
          }
        }
      }
      
      console.log(`Loaded ${tickers.length} stock tickers`);
      resolve(stockMap);
    } catch (error) {
      console.error("Error loading stock data:", error);
      resolve({});
    }
  });
};

const detectAsset = async (query) => {
    try {
        // Load asset data from all sources
        const cryptoAssets = loadCryptoData();
        const stockAssets = await loadStockData();
        const marketAssets = loadMarketData(); // FX, indices, commodities
        
        console.log(`Detecting assets in query: "${query}"`);
        
        // Common words to ignore
        const commonWords = ['is', 'now', 'a', 'good', 'time', 'to', 'buy', 'sell', 'invest', 'in', 'the', 'and', 
                            'or', 'for', 'should', 'i', 'my', 'about', 'what', 'how', 'when', 'price', 'value', 
                            'which', 'better', 'worse', 'best', 'worst', 'crypto', 'cryptocurrency', 'stock',
                            'market', 'trading', 'shares', 'equity', 'securities', 'commodity', 'index', 'forex',
                            'currency', 'exchange', 'rate', 'pair'];
        
        // Check for exact ticker/symbol matches first (prioritize these)
        const queryUpperCase = query.toUpperCase();
        
        // Check for currency pairs in the format XXX/YYY
        const currencyPairRegex = /([A-Z]{3})\/([A-Z]{3})/g;
        const currencyPairMatches = [...queryUpperCase.matchAll(currencyPairRegex)];
        
        if (currencyPairMatches.length > 0) {
            const pairSymbol = currencyPairMatches[0][0];
            if (marketAssets[pairSymbol.toLowerCase()]) {
                const asset = marketAssets[pairSymbol.toLowerCase()];
                console.log(`Found currency pair: ${asset.symbol} (${asset.name})`);
                return asset;
            }
        }
        
        // Check for stock tickers (typically 1-5 uppercase letters)
        const stockTickerRegex = /\b[A-Z]{1,5}\b/g;
        const stockTickerMatches = [...queryUpperCase.matchAll(stockTickerRegex)];
        
        for (const match of stockTickerMatches) {
            const ticker = match[0];
            if (stockAssets[ticker.toLowerCase()]) {
                const asset = stockAssets[ticker.toLowerCase()];
                console.log(`Found stock ticker: ${asset.symbol} (${asset.name})`);
                return asset;
            }
            
            // Also check if it's an index or commodity symbol
            if (marketAssets[ticker.toLowerCase()]) {
                const asset = marketAssets[ticker.toLowerCase()];
                console.log(`Found market asset symbol: ${asset.symbol} (${asset.name})`);
                return asset;
            }
        }
        
        // Split query into words and filter out common words
        const queryWords = query.toLowerCase().split(/\s+/).filter(word => !commonWords.includes(word));
        
        // Check for exact matches in all asset types
        for (const word of queryWords) {
            if (word.length < 2) continue; // Skip very short words
            
            // Check crypto assets
            if (cryptoAssets[word]) {
                console.log(`Found crypto asset match: ${cryptoAssets[word].name} (${cryptoAssets[word].symbol})`);
                return cryptoAssets[word];
            }
            
            // Check stock assets
            if (stockAssets[word]) {
                console.log(`Found stock match: ${stockAssets[word].name} (${stockAssets[word].symbol})`);
                return stockAssets[word];
            }
            
            // Check market assets (FX, indices, commodities)
            if (marketAssets[word]) {
                console.log(`Found market asset match: ${marketAssets[word].name} (${marketAssets[word].type})`);
                return marketAssets[word];
            }
        }
        
        // Check for multi-word asset names in the full query
        const fullQuery = query.toLowerCase();
        
        // First check for specific asset types mentioned
        if (fullQuery.includes('gold') || fullQuery.includes('xau')) {
            return marketAssets['gold'];
        }
        
        if (fullQuery.includes('oil') || fullQuery.includes('crude')) {
            return marketAssets['crude_oil_wti'];
        }
        
        if (fullQuery.includes('s&p') || fullQuery.includes('s and p') || fullQuery.includes('spx')) {
            return marketAssets['spx'];
        }
        
        if (fullQuery.includes('dow') || fullQuery.includes('djia')) {
            return marketAssets['djia'];
        }
        
        if (fullQuery.includes('nasdaq')) {
            return marketAssets['comp'];
        }
        
        // Check for longer asset names
        for (const [key, asset] of Object.entries(marketAssets)) {
            if (key.length > 5 && fullQuery.includes(key)) {
                console.log(`Found market asset in query: ${asset.name}`);
                return asset;
            }
        }
        
        for (const [key, asset] of Object.entries(stockAssets)) {
            if (key.length > 5 && fullQuery.includes(key)) {
                console.log(`Found company name in query: ${asset.name}`);
                return asset;
            }
        }
        
        for (const [key, asset] of Object.entries(cryptoAssets)) {
            if (key.length > 5 && fullQuery.includes(key)) {
                console.log(`Found crypto name in query: ${asset.name}`);
                return asset;
            }
        }
        
        // Default to bitcoin if no matches found
        console.log("No reliable asset matches found, defaulting to bitcoin");
        return {
            id: "1",
            name: "Bitcoin",
            symbol: "BTC",
            type: "crypto"
        };
    } catch (error) {
        console.error("Error detecting asset:", error);
        return {
            id: "1",
            name: "Bitcoin",
            symbol: "BTC",
            type: "crypto"
        };
    }
};


const getFinancialNews = async (asset) => {
    try {
        // Define news sources based on asset type
        let newsSources = [];
        let searchTerms = [];
        
        switch(asset.type) {
            case 'crypto':
                newsSources = ['coindesk.com', 'cointelegraph.com', 'decrypt.co', 'theblock.co', 'bloomberg.com'];
                searchTerms = [asset.name, asset.symbol, 'cryptocurrency'];
                break;
            case 'stock':
                newsSources = ['cnbc.com', 'bloomberg.com', 'reuters.com', 'wsj.com', 'marketwatch.com', 'seekingalpha.com'];
                searchTerms = [asset.name, asset.symbol, 'stock', 'earnings'];
                break;
            case 'commodity':
                newsSources = ['reuters.com', 'bloomberg.com', 'spglobal.com', 'argusmedia.com', 'cnbc.com'];
                searchTerms = [asset.name, 'commodity', 'futures', asset.category];
                break;
            case 'fx':
                newsSources = ['fxstreet.com', 'dailyfx.com', 'forexlive.com', 'reuters.com', 'bloomberg.com'];
                searchTerms = [asset.name, 'forex', 'currency', 'exchange rate'];
                break;
            case 'index':
                newsSources = ['cnbc.com', 'bloomberg.com', 'reuters.com', 'wsj.com', 'marketwatch.com'];
                searchTerms = [asset.name, 'index', 'market', asset.country];
                break;
            default:
                newsSources = ['reuters.com', 'bloomberg.com', 'cnbc.com', 'wsj.com'];
                searchTerms = [asset.name, asset.symbol];
        }
        
        // Create search query
        const query = searchTerms.join(' OR ');
        
        // Fetch news related to the query
        const response = await axios.get(`https://newsapi.org/v2/everything`, {
            params: {
                q: query,
                domains: newsSources.join(','),
                apiKey: process.env.NEWS_API_KEY,
                language: "en",
                sortBy: "publishedAt",
                pageSize: 10
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
        
        // Implement fallback logic - try a more general search
        try {
            const response = await axios.get(`https://newsapi.org/v2/everything`, {
                params: {
                    q: asset.name,
                    apiKey: process.env.NEWS_API_KEY,
                    language: "en",
                    sortBy: "publishedAt",
                    pageSize: 5
                }
            });
            
            if (response.data.articles && response.data.articles.length > 0) {
                return response.data.articles.map(article => ({
                    title: article.title,
                    url: article.url,
                    source: article.source.name,
                    description: article.description || "No description available.",
                    publishedAt: article.publishedAt
                }));
            }
        } catch (fallbackError) {
            console.error("Fallback news search also failed:", fallbackError.message);
        }
        
        // Return empty array if all attempts fail
        return [];
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
            { 
                role: "system", 
                content: "You are a financial analyst. Provide insights based on asset price and social sentiment. Format your response in clear paragraphs with proper spacing between them. Tag news sources inline using <span class=\"news-source\" data-source=\"SOURCE_NAME\">[SOURCE_NAME]</span> format. At the end of your analysis, include a 'Sources:' section with numbered links to each source you referenced."
            },
            { 
                role: "user", 
                content: `${userQuery}\n\n${asset} is currently priced at $${assetPrice}. Social media sentiment is ${sentiment}. Should I invest?` +
                         "\n\nReference these news sources in your analysis where relevant: Barron's, Investor's Business Daily, MarketWatch, Bloomberg, CNBC, Wall Street Journal, Financial Times, Reuters, CoinDesk, and CoinTelegraph. Tag each source appropriately in your response."
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
