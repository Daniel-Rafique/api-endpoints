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
    let marketData;
    
    try {
      // Try to read and parse the file
      const rawData = fs.readFileSync(marketDataPath, 'utf8');
      
      // Check if the file is empty
      if (!rawData || rawData.trim() === '') {
        console.log("Market data file is empty, using default data");
        marketData = getDefaultMarketData();
      } else {
        marketData = JSON.parse(rawData);
      }
    } catch (fileError) {
      // Handle file not found or JSON parse error
      console.log(`Error reading market data file: ${fileError.message}, using default data`);
      marketData = getDefaultMarketData();
    }
    
    // Create a unified map for easier lookup
    const assetMap = {};
    
    // Process FX pairs
    if (marketData.fx_pairs && Array.isArray(marketData.fx_pairs)) {
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
    }
    
    // Process indices
    if (marketData.indices && Array.isArray(marketData.indices)) {
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
    }
    
    // Process commodities
    if (marketData.commodities && Array.isArray(marketData.commodities)) {
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
    }
    
    return assetMap;
  } catch (error) {
    console.error("Error loading market data:", error);
    return getDefaultMarketDataMap();
  }
};

// Function to provide default market data when the file is missing or empty
const getDefaultMarketData = () => {
  return {
    fx_pairs: [
      {
        "id": "EUR_USD",
        "name": "Euro / US Dollar",
        "symbol": "EUR/USD",
        "base": "EUR",
        "quote": "USD",
        "type": "fx"
      },
      {
        "id": "USD_JPY",
        "name": "US Dollar / Japanese Yen",
        "symbol": "USD/JPY",
        "base": "USD",
        "quote": "JPY",
        "type": "fx"
      },
      {
        "id": "GBP_USD",
        "name": "British Pound / US Dollar",
        "symbol": "GBP/USD",
        "base": "GBP",
        "quote": "USD",
        "type": "fx"
      },
      {
        "id": "USD_CHF",
        "name": "US Dollar / Swiss Franc",
        "symbol": "USD/CHF",
        "base": "USD",
        "quote": "CHF",
        "type": "fx"
      },
      {
        "id": "AUD_USD",
        "name": "Australian Dollar / US Dollar",
        "symbol": "AUD/USD",
        "base": "AUD",
        "quote": "USD",
        "type": "fx"
      }
    ],
    indices: [
      {
        "id": "SPX",
        "name": "S&P 500",
        "symbol": "SPX",
        "country": "US",
        "type": "index"
      },
      {
        "id": "DJIA",
        "name": "Dow Jones Industrial Average",
        "symbol": "DJIA",
        "country": "US",
        "type": "index"
      },
      {
        "id": "COMP",
        "name": "NASDAQ Composite",
        "symbol": "COMP",
        "country": "US",
        "type": "index"
      },
      {
        "id": "NDX",
        "name": "NASDAQ-100",
        "symbol": "NDX",
        "country": "US",
        "type": "index"
      },
      {
        "id": "RUT",
        "name": "Russell 2000",
        "symbol": "RUT",
        "country": "US",
        "type": "index"
      }
    ],
    commodities: [
      {
        "id": "GOLD",
        "name": "Gold",
        "symbol": "XAU",
        "category": "Precious Metals",
        "type": "commodity"
      },
      {
        "id": "SILVER",
        "name": "Silver",
        "symbol": "XAG",
        "category": "Precious Metals",
        "type": "commodity"
      },
      {
        "id": "CRUDE_OIL_WTI",
        "name": "Crude Oil WTI",
        "symbol": "CL",
        "category": "Energy",
        "type": "commodity"
      },
      {
        "id": "NATURAL_GAS",
        "name": "Natural Gas",
        "symbol": "NG",
        "category": "Energy",
        "type": "commodity"
      },
      {
        "id": "COPPER",
        "name": "Copper",
        "symbol": "HG",
        "category": "Base Metals",
        "type": "commodity"
      }
    ]
  };
};

// Function to provide a pre-processed map of default market data
const getDefaultMarketDataMap = () => {
  const defaultData = getDefaultMarketData();
  const assetMap = {};
  
  // Process FX pairs
  defaultData.fx_pairs.forEach(pair => {
    assetMap[pair.id.toLowerCase()] = pair;
    assetMap[pair.symbol.toLowerCase()] = pair;
    assetMap[pair.name.toLowerCase()] = pair;
  });
  
  // Process indices
  defaultData.indices.forEach(index => {
    assetMap[index.id.toLowerCase()] = index;
    assetMap[index.symbol.toLowerCase()] = index;
    assetMap[index.name.toLowerCase()] = index;
  });
  
  // Process commodities
  defaultData.commodities.forEach(commodity => {
    assetMap[commodity.id.toLowerCase()] = commodity;
    assetMap[commodity.symbol.toLowerCase()] = commodity;
    assetMap[commodity.name.toLowerCase()] = commodity;
  });
  
  return assetMap;
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

const loadDefiData = () => {
  return new Promise((resolve, reject) => {
    try {
      const defiDataPath = path.join(__dirname, 'assetDetection', 'defiData', 'latest100.json');
      const defiData = JSON.parse(fs.readFileSync(defiDataPath, 'utf8'));
      resolve(defiData);
    } catch (error) {
      console.error("Error loading defi data:", error);
      resolve({});
    }
  });
};

const getTokenInfoFromDexScreener = async (contractAddress) => {
    try {
        const response = await axios.get(`https://api.dexscreener.com/latest/dex/search`, {
            params: {
                q: contractAddress
            }
        });
        
        if (response.data && response.data.pairs && response.data.pairs.length > 0) {
            // Return the first pair (most relevant result)
            const pair = response.data.pairs[0];
            return {
                id: pair.baseToken.address,
                name: pair.baseToken.name,
                symbol: pair.baseToken.symbol,
                type: 'crypto',
                priceUsd: pair.priceUsd,
                priceNative: pair.priceNative,
                volume24h: pair.volume.h24,
                priceChange24h: pair.priceChange.h24,
                liquidity: pair.liquidity.usd,
                marketCap: pair.marketCap,
                dexInfo: {
                    dexId: pair.dexId,
                    pairAddress: pair.pairAddress,
                    chainId: pair.chainId,
                    url: pair.url,
                    quoteToken: pair.quoteToken,
                    info: pair.info
                }
            };
        }
        return null;
    } catch (error) {
        console.error("Error fetching token info from DexScreener:", error);
        return null;
    }
};

const detectAsset = async (query) => {
    try {
        // First check if the query contains a crypto contract address
        const contractAddressRegex = /(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/g;
        const contractAddressMatches = [...query.matchAll(contractAddressRegex)];
        
        if (contractAddressMatches.length > 0) {
            // Use the first match (most likely the contract address)
            const contractAddress = contractAddressMatches[0][0];
            const tokenInfo = await getTokenInfoFromDexScreener(contractAddress);
            
            if (tokenInfo) {
                console.log(`Found token via contract address: ${tokenInfo.name} (${tokenInfo.symbol})`);
                return tokenInfo;
            }
        }
        
        // Load all asset data
        const cryptoAssets = loadCryptoData();
        const stockAssets = await loadStockData();
        const marketAssets = loadMarketData(); // FX, indices, commodities
        
        console.log(`Detecting assets in query: "${query}"`);
        
        // Improved commodity detection - check for commodity names first
        const commodityKeywords = {
            'gold': { id: "GOLD", name: "Gold", symbol: "XAU", category: "Precious Metals", type: "commodity" },
            'silver': { id: "SILVER", name: "Silver", symbol: "XAG", category: "Precious Metals", type: "commodity" },
            'platinum': { id: "PLATINUM", name: "Platinum", symbol: "XPT", category: "Precious Metals", type: "commodity" },
            'palladium': { id: "PALLADIUM", name: "Palladium", symbol: "XPD", category: "Precious Metals", type: "commodity" },
            'crude oil': { id: "CRUDE_OIL_WTI", name: "Crude Oil WTI", symbol: "CL", category: "Energy", type: "commodity" },
            'crude': { id: "CRUDE_OIL_WTI", name: "Crude Oil WTI", symbol: "CL", category: "Energy", type: "commodity" },
            'oil': { id: "CRUDE_OIL_WTI", name: "Crude Oil WTI", symbol: "CL", category: "Energy", type: "commodity" },
            'brent': { id: "BRENT_CRUDE", name: "Brent Crude Oil", symbol: "BZ", category: "Energy", type: "commodity" },
            'brent crude': { id: "BRENT_CRUDE", name: "Brent Crude Oil", symbol: "BZ", category: "Energy", type: "commodity" },
            'natural gas': { id: "NATURAL_GAS", name: "Natural Gas", symbol: "NG", category: "Energy", type: "commodity" },
            'copper': { id: "COPPER", name: "Copper", symbol: "HG", category: "Base Metals", type: "commodity" },
            'aluminum': { id: "ALUMINUM", name: "Aluminum", symbol: "ALU", category: "Base Metals", type: "commodity" },
            'aluminium': { id: "ALUMINUM", name: "Aluminum", symbol: "ALU", category: "Base Metals", type: "commodity" },
            'nickel': { id: "NICKEL", name: "Nickel", symbol: "NI", category: "Base Metals", type: "commodity" },
            'zinc': { id: "ZINC", name: "Zinc", symbol: "ZNC", category: "Base Metals", type: "commodity" },
            'lead': { id: "LEAD", name: "Lead", symbol: "LD", category: "Base Metals", type: "commodity" },
            'corn': { id: "CORN", name: "Corn", symbol: "ZC", category: "Agriculture", type: "commodity" },
            'wheat': { id: "WHEAT", name: "Wheat", symbol: "ZW", category: "Agriculture", type: "commodity" },
            'soybeans': { id: "SOYBEANS", name: "Soybeans", symbol: "ZS", category: "Agriculture", type: "commodity" },
            'coffee': { id: "COFFEE", name: "Coffee", symbol: "KC", category: "Agriculture", type: "commodity" },
            'sugar': { id: "SUGAR", name: "Sugar", symbol: "SB", category: "Agriculture", type: "commodity" },
            'cotton': { id: "COTTON", name: "Cotton", symbol: "CT", category: "Agriculture", type: "commodity" },
            'cocoa': { id: "COCOA", name: "Cocoa", symbol: "CC", category: "Agriculture", type: "commodity" }
        };
        
        // Check for commodity keywords in the query
        const lowerQuery = query.toLowerCase();
        for (const [keyword, commodity] of Object.entries(commodityKeywords)) {
            if (lowerQuery.includes(keyword)) {
                console.log(`Found commodity keyword match: ${commodity.name} (${commodity.symbol})`);
                return commodity;
            }
        }
        
        // Check for commodity symbols
        const commoditySymbols = {
            'XAU': commodityKeywords['gold'],
            'XAG': commodityKeywords['silver'],
            'XPT': commodityKeywords['platinum'],
            'XPD': commodityKeywords['palladium'],
            'CL': commodityKeywords['crude oil'],
            'BZ': commodityKeywords['brent crude'],
            'NG': commodityKeywords['natural gas'],
            'HG': commodityKeywords['copper'],
            'ALU': commodityKeywords['aluminum'],
            'NI': commodityKeywords['nickel'],
            'ZNC': commodityKeywords['zinc'],
            'LD': commodityKeywords['lead'],
            'ZC': commodityKeywords['corn'],
            'ZW': commodityKeywords['wheat'],
            'ZS': commodityKeywords['soybeans'],
            'KC': commodityKeywords['coffee'],
            'SB': commodityKeywords['sugar'],
            'CT': commodityKeywords['cotton'],
            'CC': commodityKeywords['cocoa']
        };
        
        const queryUpperCase = query.toUpperCase();
        for (const [symbol, commodity] of Object.entries(commoditySymbols)) {
            if (queryUpperCase.includes(symbol)) {
                console.log(`Found commodity symbol match: ${commodity.name} (${commodity.symbol})`);
                return commodity;
            }
        }
        
        // Common words to ignore
        const commonWords = ['is', 'now', 'a', 'good', 'time', 'to', 'buy', 'sell', 'invest', 'in', 'the', 'and', 
                            'or', 'for', 'should', 'i', 'my', 'about', 'what', 'how', 'when', 'price', 'value', 
                            'which', 'better', 'worse', 'best', 'worst', 'crypto', 'cryptocurrency', 'stock',
                            'market', 'trading', 'shares', 'equity', 'securities', 'commodity', 'index', 'forex',
                            'currency', 'exchange', 'rate', 'pair'];
        
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
        if (fullQuery.includes('s&p') || fullQuery.includes('s and p') || fullQuery.includes('spx')) {
            return marketAssets['spx'];
        }
        
        if (fullQuery.includes('dow') || fullQuery.includes('djia')) {
            return marketAssets['djia'];
        }
        
        if (fullQuery.includes('nasdaq')) {
            return marketAssets['comp'];
        }
        
        // Add specific checks for common companies that might not be in the data
        if (fullQuery.includes('amazon')) {
            return {
                id: "AMZN",
                name: "Amazon.com Inc.",
                symbol: "AMZN",
                type: "stock"
            };
        }
        
        if (fullQuery.includes('apple')) {
            return {
                id: "AAPL",
                name: "Apple Inc.",
                symbol: "AAPL",
                type: "stock"
            };
        }
        
        if (fullQuery.includes('google') || fullQuery.includes('alphabet')) {
            return {
                id: "GOOGL",
                name: "Alphabet Inc. (Google)",
                symbol: "GOOGL",
                type: "stock"
            };
        }
        
        if (fullQuery.includes('microsoft')) {
            return {
                id: "MSFT",
                name: "Microsoft Corporation",
                symbol: "MSFT",
                type: "stock"
            };
        }
        
        if (fullQuery.includes('tesla')) {
            return {
                id: "TSLA",
                name: "Tesla Inc.",
                symbol: "TSLA",
                type: "stock"
            };
        }
        
        if (fullQuery.includes('meta') || fullQuery.includes('facebook')) {
            return {
                id: "META",
                name: "Meta Platforms Inc.",
                symbol: "META",
                type: "stock"
            };
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
        // If asset has priceUsd from DexScreener, use that
        if (asset.priceUsd) {
            return asset.priceUsd;
        }
        
        // Try primary data source first
        try {
            const price = await getPrimaryAssetPrice(asset);
            console.log(`Successfully fetched price for ${asset.name} from primary source: $${price}`);
            return price;
        } catch (primaryError) {
            // If primary source fails, try fallback
            console.log(`Primary data source failed for ${asset.name}, trying fallback sources...`);
            const fallbackPrice = await getFallbackAssetPrice(asset);
            
            if (fallbackPrice !== "N/A") {
                console.log(`Successfully fetched price for ${asset.name} from fallback source: $${fallbackPrice}`);
                return fallbackPrice;
            }
            
            // If we get here, all API sources have failed
            console.error(`All API sources failed for ${asset.name}`);
            return "N/A";
        }
    } catch (error) {
        console.error(`All attempts to fetch price for ${asset.name} failed:`, error);
        return "N/A";
    }
};

// Update the getPrimaryAssetPrice function to better handle commodities
const getPrimaryAssetPrice = async (asset) => {
    try {
        console.log(`Fetching primary price data for ${asset.name} (${asset.type})`);
        
        switch(asset.type) {
            case 'crypto':
                // Use CoinGecko for crypto prices
                const cryptoResponse = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
                    params: { 
                        ids: asset.id.toLowerCase(), 
                        vs_currencies: "usd" 
                    }
                });
                if (cryptoResponse.data && cryptoResponse.data[asset.id.toLowerCase()]?.usd) {
                    return cryptoResponse.data[asset.id.toLowerCase()].usd;
                }
                break;
                
            case 'commodity':
                // Try multiple sources for commodity prices
                
                // 1. Try FMP API first
                if (process.env.FMP_API_KEY) {
                    try {
                        const fmpSymbol = getCommodityTickerForFMP(asset.symbol);
                        console.log(`Trying FMP API for ${asset.name} with symbol: ${fmpSymbol}`);
                        
                        const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${fmpSymbol}`, {
                            params: {
                                apikey: process.env.FMP_API_KEY
                            }
                        });
                        
                        if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                            console.log(`FMP API returned price for ${asset.name}: $${fmpResponse.data[0].price}`);
                            return fmpResponse.data[0].price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`Error fetching ${asset.name} price from FMP:`, error.message);
                    }
                    
                    // Try alternative FMP endpoint
                    try {
                        const fmpSymbol = getCommodityTickerForFMP(asset.symbol);
                        console.log(`Trying alternative FMP endpoint for ${asset.name}`);
                        
                        const fmpAltResponse = await axios.get(`https://financialmodelingprep.com/api/v3/historical-price-full/commodity/${fmpSymbol}`, {
                            params: {
                                apikey: process.env.FMP_API_KEY
                            }
                        });
                        
                        if (fmpAltResponse.data && 
                            fmpAltResponse.data.historical && 
                            fmpAltResponse.data.historical.length > 0) {
                            
                            const latestPrice = fmpAltResponse.data.historical[0].close;
                            console.log(`FMP historical endpoint returned price for ${asset.name}: $${latestPrice}`);
                            return latestPrice.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`Error fetching ${asset.name} historical price from FMP:`, error.message);
                    }
                }
                
                // 2. Try Alpha Vantage
                if (process.env.ALPHA_VANTAGE_API_KEY) {
                    try {
                        // Map commodity symbols to Alpha Vantage symbols
                        const avSymbol = getCommodityTickerForAlphaVantage(asset.symbol);
                        console.log(`Trying Alpha Vantage for ${asset.name} with symbol: ${avSymbol}`);
                        
                        const avResponse = await axios.get("https://www.alphavantage.co/query", {
                            params: {
                                function: "GLOBAL_QUOTE",
                                symbol: avSymbol,
                                apikey: process.env.ALPHA_VANTAGE_API_KEY
                            }
                        });
                        
                        if (avResponse.data && avResponse.data["Global Quote"] && 
                            avResponse.data["Global Quote"]["05. price"]) {
                            
                            const price = parseFloat(avResponse.data["Global Quote"]["05. price"]);
                            console.log(`Alpha Vantage returned price for ${asset.name}: $${price}`);
                            return price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`Error fetching ${asset.name} price from Alpha Vantage:`, error.message);
                    }
                }
                
                // 3. Try Yahoo Finance
                try {
                    // Map commodity symbols to Yahoo Finance symbols
                    const yahooSymbol = getCommodityTickerForYahoo(asset.symbol);
                    console.log(`Trying Yahoo Finance for ${asset.name} with symbol: ${yahooSymbol}`);
                    
                    const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}`, {
                        params: {
                            interval: '1d',
                            range: '1d'
                        }
                    });
                    
                    if (yahooResponse.data && yahooResponse.data.chart && 
                        yahooResponse.data.chart.result && 
                        yahooResponse.data.chart.result[0].meta && 
                        yahooResponse.data.chart.result[0].meta.regularMarketPrice) {
                        
                        const price = yahooResponse.data.chart.result[0].meta.regularMarketPrice;
                        console.log(`Yahoo Finance returned price for ${asset.name}: $${price}`);
                        return price.toFixed(2);
                    }
                } catch (error) {
                    console.error(`Error fetching ${asset.name} price from Yahoo Finance:`, error.message);
                }
                
                // If we get here, all commodity price sources failed
                throw new Error(`All commodity price sources failed for ${asset.name}`);
                
            case 'stock':
                // Use Alpha Vantage for stock prices
                if (process.env.ALPHA_VANTAGE_API_KEY) {
                    const stockResponse = await axios.get("https://www.alphavantage.co/query", {
                        params: {
                            function: "GLOBAL_QUOTE",
                            symbol: asset.symbol,
                            apikey: process.env.ALPHA_VANTAGE_API_KEY
                        }
                    });
                    
                    if (stockResponse.data && stockResponse.data["Global Quote"] && 
                        stockResponse.data["Global Quote"]["05. price"]) {
                        return parseFloat(stockResponse.data["Global Quote"]["05. price"]).toFixed(2);
                    }
                }
                break;
                
            case 'index':
                // Use Alpha Vantage for index prices with proper symbol formatting
                if (process.env.ALPHA_VANTAGE_API_KEY) {
                    // Format index symbols properly (e.g., ^SPX for S&P 500)
                    const indexSymbol = asset.symbol.startsWith('^') ? asset.symbol : `^${asset.symbol}`;
                    
                    const response = await axios.get("https://www.alphavantage.co/query", {
                        params: {
                            function: "GLOBAL_QUOTE",
                            symbol: indexSymbol,
                            apikey: process.env.ALPHA_VANTAGE_API_KEY
                        }
                    });
                    
                    if (response.data && response.data["Global Quote"] && 
                        response.data["Global Quote"]["05. price"]) {
                        return parseFloat(response.data["Global Quote"]["05. price"]).toFixed(2);
                    }
                }
                
                // Try FMP API as an alternative for indices
                if (process.env.FMP_API_KEY) {
                    const fmpSymbol = asset.symbol === 'SPX' ? 'S&P500' : 
                                     (asset.symbol === 'DJIA' ? 'DOW' : 
                                     (asset.symbol === 'COMP' ? 'NASDAQ' : asset.symbol));
                    
                    const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${fmpSymbol}`, {
                        params: {
                            apikey: process.env.FMP_API_KEY
                        }
                    });
                    
                    if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                        return fmpResponse.data[0].price.toFixed(2);
                    }
                }
                break;
                
            case 'fx':
                // Use Alpha Vantage for FX prices with proper symbol formatting
                if (process.env.ALPHA_VANTAGE_API_KEY) {
                    // Format FX symbols properly (e.g., EURUSD for EUR/USD)
                    const fxSymbol = `${asset.base}${asset.quote}`;
                    
                    const response = await axios.get("https://www.alphavantage.co/query", {
                        params: {
                            function: "CURRENCY_EXCHANGE_RATE",
                            from_currency: asset.base,
                            to_currency: asset.quote,
                            apikey: process.env.ALPHA_VANTAGE_API_KEY
                        }
                    });
                    
                    if (response.data && 
                        response.data["Realtime Currency Exchange Rate"] && 
                        response.data["Realtime Currency Exchange Rate"]["5. Exchange Rate"]) {
                        return parseFloat(response.data["Realtime Currency Exchange Rate"]["5. Exchange Rate"]).toFixed(4);
                    }
                }
                
                // Try FMP API as an alternative for FX
                if (process.env.FMP_API_KEY) {
                    const fmpSymbol = `${asset.base}/${asset.quote}`;
                    
                    const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/fx/${fmpSymbol}`, {
                        params: {
                            apikey: process.env.FMP_API_KEY
                        }
                    });
                    
                    if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                        return fmpResponse.data[0].price.toFixed(4);
                    }
                }
                break;
        }
        
        // If we get here, the primary source failed
        throw new Error(`Primary data source failed for ${asset.name}`);
    } catch (error) {
        console.error(`Primary data source error for ${asset.name}:`, error.message);
        throw error; // Propagate the error to be handled by getFallbackAssetPrice
    }
};

// Add new helper functions for mapping commodity symbols to different API formats
const getCommodityTickerForFMP = (symbol) => {
    const mapping = {
        'XAU': 'GOLD',      // Gold
        'XAG': 'SILVER',    // Silver
        'XPT': 'PLATINUM',  // Platinum
        'XPD': 'PALLADIUM', // Palladium
        'CL': 'USOIL',      // Crude Oil WTI
        'BZ': 'UKOIL',      // Brent Crude Oil
        'NG': 'NATGAS',     // Natural Gas
        'HG': 'COPPER',     // Copper
        'ALU': 'ALUMINUM',  // Aluminum
        'NI': 'NICKEL',     // Nickel
        'ZNC': 'ZINC',      // Zinc
        'LD': 'LEAD',       // Lead
        'ZC': 'CORN',       // Corn
        'ZW': 'WHEAT',      // Wheat
        'ZS': 'SOYBEAN',    // Soybeans
        'KC': 'COFFEE',     // Coffee
        'SB': 'SUGAR',      // Sugar
        'CT': 'COTTON',     // Cotton
        'CC': 'COCOA'       // Cocoa
    };
    
    return mapping[symbol] || symbol;
};

const getCommodityTickerForAlphaVantage = (symbol) => {
    const mapping = {
        'XAU': 'GC=F',      // Gold Futures
        'XAG': 'SI=F',      // Silver Futures
        'XPT': 'PL=F',      // Platinum Futures
        'XPD': 'PA=F',      // Palladium Futures
        'CL': 'CL=F',       // Crude Oil WTI Futures
        'BZ': 'BZ=F',       // Brent Crude Oil Futures
        'NG': 'NG=F',       // Natural Gas Futures
        'HG': 'HG=F',       // Copper Futures
        'ALU': 'ALI=F',     // Aluminum Futures
        'NI': 'NI=F',       // Nickel Futures
        'ZNC': 'ZN=F',      // Zinc Futures
        'LD': 'LD=F',       // Lead Futures
        'ZC': 'ZC=F',       // Corn Futures
        'ZW': 'ZW=F',       // Wheat Futures
        'ZS': 'ZS=F',       // Soybean Futures
        'KC': 'KC=F',       // Coffee Futures
        'SB': 'SB=F',       // Sugar Futures
        'CT': 'CT=F',       // Cotton Futures
        'CC': 'CC=F'        // Cocoa Futures
    };
    
    return mapping[symbol] || symbol;
};

const getCommodityTickerForYahoo = (symbol) => {
    const mapping = {
        'XAU': 'GC=F',      // Gold Futures
        'XAG': 'SI=F',      // Silver Futures
        'XPT': 'PL=F',      // Platinum Futures
        'XPD': 'PA=F',      // Palladium Futures
        'CL': 'CL=F',       // Crude Oil WTI Futures
        'BZ': 'BZ=F',       // Brent Crude Oil Futures
        'NG': 'NG=F',       // Natural Gas Futures
        'HG': 'HG=F',       // Copper Futures
        'ALU': 'ALI=F',     // Aluminum Futures
        'NI': 'NI=F',       // Nickel Futures
        'ZNC': 'ZN=F',      // Zinc Futures
        'LD': 'LD=F',       // Lead Futures
        'ZC': 'ZC=F',       // Corn Futures
        'ZW': 'ZW=F',       // Wheat Futures
        'ZS': 'ZS=F',       // Soybean Futures
        'KC': 'KC=F',       // Coffee Futures
        'SB': 'SB=F',       // Sugar Futures
        'CT': 'CT=F',       // Cotton Futures
        'CC': 'CC=F'        // Cocoa Futures
    };
    
    // For ETFs as alternatives
    const etfMapping = {
        'XAU': 'GLD',       // SPDR Gold Shares ETF
        'XAG': 'SLV',       // iShares Silver Trust ETF
        'CL': 'USO',        // United States Oil Fund ETF
        'NG': 'UNG'         // United States Natural Gas Fund ETF
    };
    
    return mapping[symbol] || etfMapping[symbol] || symbol;
};

// Update the getFallbackAssetPrice function to use more sources for commodities
const getFallbackAssetPrice = async (asset) => {
    try {
        console.log(`Trying fallback sources for ${asset.name} (${asset.type})`);
        
        switch(asset.type) {
            case 'commodity':
                // Try ETF proxies for commodities
                try {
                    // Get ETF symbol that tracks this commodity
                    const etfSymbol = getCommodityETFProxy(asset.symbol);
                    console.log(`Trying ETF proxy for ${asset.name}: ${etfSymbol}`);
                    
                    if (etfSymbol) {
                        const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${etfSymbol}`, {
                            params: {
                                interval: '1d',
                                range: '1d'
                            }
                        });
                        
                        if (yahooResponse.data && yahooResponse.data.chart && 
                            yahooResponse.data.chart.result && 
                            yahooResponse.data.chart.result[0].meta && 
                            yahooResponse.data.chart.result[0].meta.regularMarketPrice) {
                            
                            const etfPrice = yahooResponse.data.chart.result[0].meta.regularMarketPrice;
                            const commodityPrice = convertETFPriceToCommodityPrice(asset.symbol, etfPrice);
                            
                            console.log(`ETF proxy ${etfSymbol} price: $${etfPrice}, converted ${asset.name} price: $${commodityPrice}`);
                            return commodityPrice.toFixed(2);
                        }
                    }
                } catch (error) {
                    console.error(`ETF proxy fallback failed for ${asset.name}:`, error.message);
                }
                
                // Try MarketData API
                try {
                    console.log(`Trying MarketData API for ${asset.name}`);
                    const marketDataSymbol = getCommodityTickerForMarketData(asset.symbol);
                    
                    const marketDataResponse = await axios.get(`https://api.marketdata.app/v1/commodities/${marketDataSymbol}/quote`);
                    
                    if (marketDataResponse.data && marketDataResponse.data.c) {
                        console.log(`MarketData API returned price for ${asset.name}: $${marketDataResponse.data.c}`);
                        return marketDataResponse.data.c.toFixed(2);
                    }
                } catch (error) {
                    console.error(`MarketData API fallback failed for ${asset.name}:`, error.message);
                }
                
                // Try Metals-API for precious metals
                if (['XAU', 'XAG', 'XPT', 'XPD'].includes(asset.symbol) && process.env.METALS_API_KEY) {
                    try {
                        console.log(`Trying Metals-API for ${asset.name}`);
                        
                        const metalsResponse = await axios.get('https://metals-api.com/api/latest', {
                            params: {
                                access_key: process.env.METALS_API_KEY,
                                base: 'USD',
                                symbols: asset.symbol
                            }
                        });
                        
                        if (metalsResponse.data && metalsResponse.data.success && metalsResponse.data.rates) {
                            const rate = metalsResponse.data.rates[asset.symbol];
                            if (rate) {
                                // Metals-API returns rates as USD per ounce, so we need to invert
                                const price = 1 / rate;
                                console.log(`Metals-API returned price for ${asset.name}: $${price}`);
                                return price.toFixed(2);
                            }
                        }
                    } catch (error) {
                        console.error(`Metals-API fallback failed for ${asset.name}:`, error.message);
                    }
                }
                break;
                
            case 'crypto':
                // Try CoinMarketCap API as fallback for crypto
                if (process.env.COINMARKETCAP_API_KEY) {
                    try {
                        const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
                            headers: {
                                'X-CMC_PRO_API_KEY': process.env.COINMARKETCAP_API_KEY
                            },
                            params: {
                                symbol: asset.symbol
                            }
                        });
                        
                        if (response.data && response.data.data && response.data.data[asset.symbol]) {
                            return response.data.data[asset.symbol].quote.USD.price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`CoinMarketCap fallback failed: ${error.message}`);
                    }
                }
                
                // Try FMP API as another fallback for crypto
                if (process.env.FMP_API_KEY) {
                    try {
                        const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${asset.symbol}USD`, {
                            params: {
                                apikey: process.env.FMP_API_KEY
                            }
                        });
                        
                        if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                            return fmpResponse.data[0].price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`FMP crypto fallback failed: ${error.message}`);
                    }
                }
                break;
                
            case 'stock':
            case 'index':
                // Try FMP API as fallback for stocks and indices
                if (process.env.FMP_API_KEY) {
                    try {
                        const symbol = asset.type === 'index' ? 
                                      (asset.symbol === 'SPX' ? 'S&P500' : 
                                      (asset.symbol === 'DJIA' ? 'DOW' : 
                                      (asset.symbol === 'COMP' ? 'NASDAQ' : asset.symbol))) : 
                                      asset.symbol;
                        
                        const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/quote/${symbol}`, {
                            params: {
                                apikey: process.env.FMP_API_KEY
                            }
                        });
                        
                        if (fmpResponse.data && fmpResponse.data.length > 0 && fmpResponse.data[0].price) {
                            return fmpResponse.data[0].price.toFixed(2);
                        }
                    } catch (error) {
                        console.error(`FMP stock/index fallback failed: ${error.message}`);
                    }
                }
                
                // Try Yahoo Finance API as another fallback
                try {
                    const symbol = asset.type === 'index' ? `^${asset.symbol}` : asset.symbol;
                    const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
                        params: {
                            interval: '1d',
                            range: '1d'
                        }
                    });
                    
                    if (yahooResponse.data && yahooResponse.data.chart && 
                        yahooResponse.data.chart.result && 
                        yahooResponse.data.chart.result[0].meta && 
                        yahooResponse.data.chart.result[0].meta.regularMarketPrice) {
                        
                        return yahooResponse.data.chart.result[0].meta.regularMarketPrice.toFixed(2);
                    }
                } catch (error) {
                    console.error(`Yahoo Finance fallback failed: ${error.message}`);
                }
                break;
                
            case 'fx':
                // Try Yahoo Finance as fallback for FX
                try {
                    const symbol = `${asset.base}${asset.quote}=X`;
                    const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
                        params: {
                            interval: '1d',
                            range: '1d'
                        }
                    });
                    
                    if (yahooResponse.data && yahooResponse.data.chart && 
                        yahooResponse.data.chart.result && 
                        yahooResponse.data.chart.result[0].meta && 
                        yahooResponse.data.chart.result[0].meta.regularMarketPrice) {
                        
                        return yahooResponse.data.chart.result[0].meta.regularMarketPrice.toFixed(4);
                    }
                } catch (error) {
                    console.error(`Yahoo Finance FX fallback failed: ${error.message}`);
                }
                break;
        }
        
        // If all fallbacks fail, return N/A
        console.error(`All fallback sources failed for ${asset.name}`);
        return "N/A";
    } catch (error) {
        console.error(`Fallback data source error for ${asset.name}:`, error);
        return "N/A";
    }
};

// Helper function to get ETF proxies for commodities
const getCommodityETFProxy = (symbol) => {
    const mapping = {
        'XAU': 'GLD',       // SPDR Gold Shares ETF
        'XAG': 'SLV',       // iShares Silver Trust ETF
        'XPT': 'PPLT',      // Aberdeen Physical Platinum Shares ETF
        'XPD': 'PALL',      // Aberdeen Physical Palladium Shares ETF
        'CL': 'USO',        // United States Oil Fund ETF
        'BZ': 'BNO',        // United States Brent Oil Fund ETF
        'NG': 'UNG',        // United States Natural Gas Fund ETF
        'HG': 'CPER',       // United States Copper Index Fund ETF
        'ZC': 'CORN',       // Teucrium Corn Fund ETF
        'ZW': 'WEAT',       // Teucrium Wheat Fund ETF
        'ZS': 'SOYB',       // Teucrium Soybean Fund ETF
    };
    
    return mapping[symbol] || null;
};

// Helper function to convert ETF prices to commodity prices
const convertETFPriceToCommodityPrice = (symbol, etfPrice) => {
    // Conversion factors based on how ETFs track the underlying commodity
    const conversionFactors = {
        'XAU': 10,          // Each GLD share is roughly 1/10 oz of gold
        'XAG': 1,           // Each SLV share is roughly 1 oz of silver
        'XPT': 10,          // Approximate conversion for platinum
        'XPD': 10,          // Approximate conversion for palladium
        'CL': 1,            // Approximate conversion for oil
        'BZ': 1,            // Approximate conversion for brent
        'NG': 1,            // Approximate conversion for natural gas
        'HG': 1,            // Approximate conversion for copper
        'ZC': 1,            // Approximate conversion for corn
        'ZW': 1,            // Approximate conversion for wheat
        'ZS': 1,            // Approximate conversion for soybeans
    };
    
    const factor = conversionFactors[symbol] || 1;
    return etfPrice * factor;
};

// Helper function to map commodity symbols to MarketData API format
const getCommodityTickerForMarketData = (symbol) => {
    const mapping = {
        'XAU': 'GC',        // Gold
        'XAG': 'SI',        // Silver
        'XPT': 'PL',        // Platinum
        'XPD': 'PA',        // Palladium
        'CL': 'CL',         // Crude Oil WTI
        'BZ': 'BZ',         // Brent Crude Oil
        'NG': 'NG',         // Natural Gas
        'HG': 'HG',         // Copper
        'ZC': 'ZC',         // Corn
        'ZW': 'ZW',         // Wheat
        'ZS': 'ZS',         // Soybeans
        'KC': 'KC',         // Coffee
        'SB': 'SB',         // Sugar
        'CT': 'CT',         // Cotton
        'CC': 'CC'          // Cocoa
    };
    
    return mapping[symbol] || symbol;
};

// Update the getHistoricalData function to handle API failures better
const getHistoricalData = async (asset) => {
    try {
        console.log(`Fetching historical data for ${asset.name} (${asset.type})`);
        
        // If we have DexScreener data but no historical data,
        // generate some dummy data based on the current price
        if (asset.priceUsd && !asset.historicalData) {
            const basePrice = parseFloat(asset.priceUsd);
            const dummyData = [];
            const now = Date.now();
            
            for (let i = 0; i < 10; i++) {
                const timePoint = now - (9 - i) * 3600000; // hourly points going back from now
                const randomVariation = (Math.random() - 0.5) * 0.02 * basePrice; // ±1% variation
                dummyData.push([timePoint, basePrice + randomVariation]);
            }
            
            return dummyData;
        }
        
        let priceData = [];
        
        // Try primary source first
        switch(asset.type) {
            case 'crypto':
                try {
                    // Updated CoinGecko endpoint - use symbol instead of ID
                    console.log(`Trying CoinGecko API for ${asset.name} historical data`);
                    
                    // First try with the asset ID
                    let cryptoId = asset.id.toString().toLowerCase();
                    
                    // For Bitcoin, ensure we're using the correct ID
                    if (asset.symbol === 'BTC' || cryptoId === '1') {
                        cryptoId = 'bitcoin';
                    }
                    
                    const cryptoResponse = await axios.get(`https://api.coingecko.com/api/v3/coins/${cryptoId}/market_chart`, {
                        params: { 
                            vs_currency: "usd", 
                            days: "1" 
                        }
                    });
                    
                    if (cryptoResponse.data && cryptoResponse.data.prices && 
                        cryptoResponse.data.prices.length > 0) {
                        console.log(`Successfully fetched historical data from CoinGecko for ${asset.name}`);
                        return cryptoResponse.data.prices;
                    }
                } catch (error) {
                    console.error(`Error fetching crypto historical data from CoinGecko:`, error.message);
                    
                    // Try alternative CoinGecko endpoint with symbol
                    try {
                        console.log(`Trying alternative CoinGecko endpoint for ${asset.name}`);
                        
                        // Map common symbols to their CoinGecko IDs
                        const symbolToId = {
                            'BTC': 'bitcoin',
                            'ETH': 'ethereum',
                            'USDT': 'tether',
                            'BNB': 'binancecoin',
                            'SOL': 'solana',
                            'XRP': 'ripple',
                            'USDC': 'usd-coin',
                            'ADA': 'cardano',
                            'AVAX': 'avalanche-2',
                            'DOGE': 'dogecoin'
                        };
                        
                        const coinId = symbolToId[asset.symbol] || asset.symbol.toLowerCase();
                        
                        const altResponse = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`, {
          params: {
                                vs_currency: "usd", 
                                days: "1" 
                            }
                        });
                        
                        if (altResponse.data && altResponse.data.prices && 
                            altResponse.data.prices.length > 0) {
                            console.log(`Successfully fetched historical data from alternative CoinGecko endpoint for ${asset.name}`);
                            return altResponse.data.prices;
                        }
                    } catch (altError) {
                        console.error(`Alternative CoinGecko endpoint also failed:`, altError.message);
                    }
                }
                
                // Try CryptoCompare as a fallback for crypto
                try {
                    console.log(`Trying CryptoCompare API for ${asset.name} historical data`);
                    const cryptoCompareResponse = await axios.get('https://min-api.cryptocompare.com/data/v2/histohour', {
                        params: {
                            fsym: asset.symbol,
                            tsym: 'USD',
                            limit: 24
                        }
                    });
                    
                    if (cryptoCompareResponse.data && 
                        cryptoCompareResponse.data.Data && 
                        cryptoCompareResponse.data.Data.Data) {
                        
                        const data = cryptoCompareResponse.data.Data.Data;
                        const formattedData = data.map(point => [
                            point.time * 1000, // Convert to milliseconds
                            point.close
                        ]);
                        
                        console.log(`Successfully fetched historical data from CryptoCompare for ${asset.name}`);
                        return formattedData;
                    }
                } catch (cryptoCompareError) {
                    console.error(`CryptoCompare API failed:`, cryptoCompareError.message);
                }
                break;
                
            case 'stock':
            case 'index':
            case 'commodity':
            case 'fx':
                if (process.env.ALPHA_VANTAGE_API_KEY) {
                    try {
                        console.log(`Trying Alpha Vantage for ${asset.name} historical data`);
                        let symbol;
                        
                        if (asset.type === 'index') {
                            symbol = asset.symbol.startsWith('^') ? asset.symbol : `^${asset.symbol}`;
                        } else if (asset.type === 'fx') {
                            symbol = `${asset.base}${asset.quote}`;
                        } else if (asset.type === 'commodity') {
                            symbol = getCommodityTickerForAlphaVantage(asset.symbol);
                        } else {
                            symbol = asset.symbol;
                        }
                        
                        const response = await axios.get("https://www.alphavantage.co/query", {
                            params: {
                                function: "TIME_SERIES_INTRADAY",
                                symbol: symbol,
                                interval: "5min",
                                apikey: process.env.ALPHA_VANTAGE_API_KEY
                            }
                        });
                        
                        const timeSeries = response.data["Time Series (5min)"];
                        if (timeSeries) {
                            priceData = Object.entries(timeSeries).map(([timestamp, data]) => {
                                return [new Date(timestamp).getTime(), parseFloat(data["4. close"])];
                            }).reverse();
                            
                            if (priceData.length > 0) {
                                console.log(`Successfully fetched historical data from Alpha Vantage for ${asset.name}`);
                                return priceData;
                            }
                        }
                    } catch (error) {
                        console.error(`Error fetching historical data from Alpha Vantage:`, error.message);
                    }
                }
                
                // Try FMP API for stocks, indices, and commodities
                if (process.env.FMP_API_KEY && ['stock', 'index', 'commodity'].includes(asset.type)) {
                    try {
                        console.log(`Trying FMP API for ${asset.name} historical data`);
                        let endpoint, symbol;
                        
                        if (asset.type === 'commodity') {
                            endpoint = 'historical-price-full/commodity';
                            symbol = getCommodityTickerForFMP(asset.symbol);
                        } else if (asset.type === 'index') {
                            endpoint = 'historical-price-full/index';
                            symbol = asset.symbol === 'SPX' ? 'S&P500' : 
                                    (asset.symbol === 'DJIA' ? 'DOW' : 
                                    (asset.symbol === 'COMP' ? 'NASDAQ' : asset.symbol));
                        } else {
                            endpoint = 'historical-price-full';
                            symbol = asset.symbol;
                        }
                        
                        const fmpResponse = await axios.get(`https://financialmodelingprep.com/api/v3/${endpoint}/${symbol}`, {
                            params: {
                                apikey: process.env.FMP_API_KEY,
                                timeseries: 24
                            }
                        });
                        
                        if (fmpResponse.data && fmpResponse.data.historical) {
                            const historicalData = fmpResponse.data.historical;
                            const formattedData = historicalData.map(point => [
                                new Date(point.date).getTime(),
                                point.close
                            ]).reverse();
                            
                            if (formattedData.length > 0) {
                                console.log(`Successfully fetched historical data from FMP for ${asset.name}`);
                                return formattedData;
                            }
                        }
                    } catch (fmpError) {
                        console.error(`FMP API historical data failed:`, fmpError.message);
                    }
                }
                break;
        }
        
        // If primary source fails, try Yahoo Finance as fallback
        try {
            console.log(`Trying Yahoo Finance for ${asset.name} historical data`);
            let symbol;
            
            if (asset.type === 'crypto') {
                symbol = `${asset.symbol}-USD`;
            } else if (asset.type === 'index') {
                symbol = `^${asset.symbol}`;
            } else if (asset.type === 'fx') {
                symbol = `${asset.base}${asset.quote}=X`;
            } else if (asset.type === 'commodity') {
                symbol = getCommodityTickerForYahoo(asset.symbol);
            } else {
                symbol = asset.symbol;
            }
            
            const yahooResponse = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
                params: {
                    interval: '5m',
                    range: '1d'
                }
            });
            
            if (yahooResponse.data && yahooResponse.data.chart && 
                yahooResponse.data.chart.result && 
                yahooResponse.data.chart.result[0].timestamp && 
                yahooResponse.data.chart.result[0].indicators && 
                yahooResponse.data.chart.result[0].indicators.quote && 
                yahooResponse.data.chart.result[0].indicators.quote[0].close) {
                
                const timestamps = yahooResponse.data.chart.result[0].timestamp;
                const closePrices = yahooResponse.data.chart.result[0].indicators.quote[0].close;
                
                priceData = timestamps.map((timestamp, index) => {
                    return [timestamp * 1000, closePrices[index] || null];
                }).filter(point => point[1] !== null);
                
                if (priceData.length > 0) {
                    console.log(`Successfully fetched historical data from Yahoo Finance for ${asset.name}`);
                    return priceData;
                }
            }
        } catch (yahooError) {
            console.error(`Yahoo Finance fallback failed for historical data:`, yahooError.message);
        }
        
        // If all else fails, generate some dummy data based on the current price
        // This ensures the chart always shows something
        console.log(`All API sources failed for ${asset.name} historical data, generating dummy data`);
        const assetPrice = await getAssetData(asset);
        if (assetPrice !== "N/A") {
            const basePrice = parseFloat(assetPrice);
            const dummyData = [];
            const now = Date.now();
            
            // Generate 10 data points with small random variations
            for (let i = 0; i < 10; i++) {
                const timePoint = now - (9 - i) * 3600000; // hourly points going back from now
                const randomVariation = (Math.random() - 0.5) * 0.02 * basePrice; // ±1% variation
                dummyData.push([timePoint, basePrice + randomVariation]);
            }
            
            console.log(`Generated dummy historical data for ${asset.name}`);
            return dummyData;
        }
        
        return [];
    } catch (error) {
        console.error(`Error fetching historical data for ${asset.name}:`, error.message);
        
        // Generate dummy data as a last resort
        console.log(`Generating emergency dummy data for ${asset.name}`);
        const dummyData = [];
        const now = Date.now();
        const basePrice = 100; // Default base price if we don't know the actual price
        
        for (let i = 0; i < 10; i++) {
            const timePoint = now - (9 - i) * 3600000;
            const randomVariation = (Math.random() - 0.5) * 2; // ±1% variation
            dummyData.push([timePoint, basePrice + randomVariation]);
        console.error(`Error fetching historical data for ${asset.name}:`, error);
        return [];
    }
};

const generateChartUrl = (priceData) => {
    const dataPoints = priceData.map(point => point[1]);
    return `https://quickchart.io/chart?c={type:'line',data:{labels:[1,2,3,4,5,6,7,8,9,10],datasets:[{label:'Price',data:[${dataPoints}]}]}}`;
};

const getTwitterSentiment = async (asset) => {
    try {
        // Create a simpler query string that won't cause URL encoding issues
        const queryText = asset.type === 'stock' ? 
            `${asset.symbol} ${asset.name} stock` : 
            `${asset.name} ${asset.symbol}`;
            
        console.log(`Fetching sentiment data for: ${queryText}`);
        
        // Use the correct endpoint with proper parameter formatting
        const response = await axios.post("https://api.koynlabs.com:3003/api/search", {
            query: queryText,
            limit: 50
        });
        
        if (response.data && response.data.data && response.data.data.items && 
            Array.isArray(response.data.data.items)) {
            const tweets = response.data.data.items
                .map(item => `${item.title} ${item.description || ''}`.trim())
                .filter(text => text.length > 0);
                
            console.log(`Found ${tweets.length} social media posts for sentiment analysis`);
            return tweets;
        }
        
        // If we can't get data from our own API, try a fallback approach
        console.log("No items found in API response, using fallback method");
        return await getFallbackSentimentData(asset);
    } catch (error) {
        console.error("Error fetching social media sentiment:", error.message);
        // Implement fallback for sentiment data
        return await getFallbackSentimentData(asset);
    }
};

// Fallback function to generate some sentiment data when API fails
const getFallbackSentimentData = async (asset) => {
    try {
        // Try to get some news headlines to use for sentiment
        const news = await getFinancialNews(asset);
        if (news && news.length > 0) {
            console.log("Using news headlines for sentiment analysis");
            return news.map(article => article.title + ". " + (article.description || ""));
        }
        
        // If no news, return some generic statements based on asset type
        console.log("No news available, using generic sentiment statements");
        return generateGenericSentimentData(asset);
    } catch (error) {
        console.error("Fallback sentiment data generation failed:", error);
        return generateGenericSentimentData(asset);
    }
};

// Generate generic sentiment statements based on asset type
const generateGenericSentimentData = (asset) => {
    const statements = [];
    
    // Add some generic statements based on asset type
    switch(asset.type) {
        case 'stock':
            statements.push(
                `${asset.name} reported quarterly earnings recently.`,
                `Investors are watching ${asset.symbol} closely in this market.`,
                `Analysts have mixed opinions on ${asset.name}'s growth prospects.`,
                `${asset.symbol} stock has been volatile in recent trading sessions.`,
                `Some traders are bullish on ${asset.name} due to new product announcements.`
            );
            break;
        case 'crypto':
            statements.push(
                `${asset.name} has seen increased trading volume recently.`,
                `Crypto enthusiasts are discussing ${asset.symbol} adoption rates.`,
                `Market sentiment around ${asset.name} remains cautiously optimistic.`,
                `${asset.symbol} price movements have been correlated with broader market trends.`,
                `Some analysts predict ${asset.name} could see increased volatility soon.`
            );
            break;
        case 'commodity':
            statements.push(
                `${asset.name} prices are being affected by global supply chain issues.`,
                `Traders are monitoring ${asset.name} inventories closely.`,
                `Demand for ${asset.name} has been fluctuating with economic indicators.`,
                `${asset.name} futures suggest market uncertainty in the short term.`,
                `Geopolitical tensions are impacting ${asset.name} price forecasts.`
            );
            break;
        case 'fx':
            statements.push(
                `${asset.name} exchange rate is responding to central bank policies.`,
                `Traders are watching ${asset.symbol} amid changing interest rate expectations.`,
                `Economic data releases have caused volatility in ${asset.name}.`,
                `${asset.symbol} technical indicators show mixed signals for traders.`,
                `Currency analysts have diverse views on ${asset.name} direction.`
            );
            break;
        case 'index':
            statements.push(
                `${asset.name} components are showing mixed performance this quarter.`,
                `Market breadth in the ${asset.name} has been narrowing recently.`,
                `Investors are reassessing ${asset.name} exposure amid economic uncertainty.`,
                `${asset.name} technical patterns suggest caution for short-term traders.`,
                `Sector rotation is affecting ${asset.name} performance this month.`
            );
            break;
        default:
            statements.push(
                `Market sentiment around ${asset.name} remains mixed.`,
                `Traders are closely monitoring ${asset.name} price movements.`,
                `Analysts have diverse opinions on ${asset.name}'s outlook.`,
                `${asset.name} has seen increased attention from investors recently.`,
                `Technical indicators for ${asset.name} show conflicting signals.`
            );
    }
    
    return statements;
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

    // Prepare chart data for Chart.js
    const chartData = {
        type: 'line',
        data: {
            labels: priceData.map((point, index) => index + 1), // X-axis labels
            datasets: [{
                label: `${asset.name} Price`,
                data: priceData.map(point => point[1]), // Y-axis values
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                borderColor: 'rgba(75, 192, 192, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: false,
                    title: {
                        display: true,
                        text: 'Price (USD)'
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'Time'
                    }
                }
            }
        }
    };

    // Build the response object
    const responseData = {
        question: userQuery,
        results: [
            {
                asset: {
                    name: asset.name,
                    symbol: asset.symbol,
                    type: asset.type,
                    price: assetPrice
                },
                asset_price: assetPrice,
                chart: chartData, // Include Chart.js configuration
                social_sentiment: sentiment,
                analysis: formattedResponse
            }
        ],
        news: financialNews
    };

    // If it's a token with DexScreener data, add additional information
    if (asset.dexInfo) {
        responseData.results[0].asset = {
            ...responseData.results[0].asset,
            priceUsd: asset.priceUsd,
            priceNative: asset.priceNative,
            volume24h: asset.volume24h,
            priceChange24h: asset.priceChange24h,
            liquidity: asset.liquidity,
            marketCap: asset.marketCap,
            dexInfo: {
                dexId: asset.dexInfo.dexId,
                pairAddress: asset.dexInfo.pairAddress,
                chainId: asset.dexInfo.chainId,
                url: asset.dexInfo.url,
                quoteToken: asset.dexInfo.quoteToken,
                info: asset.dexInfo.info
            }
        };
    }

    res.json(responseData);
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
