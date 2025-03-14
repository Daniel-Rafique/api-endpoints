const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { tableFromIPC } = require('apache-arrow');
const initWasm = require('parquet-wasm');
const { readParquet } = require('parquet-wasm');

// Path to store the downloaded dataset
const DATASET_DIR = path.join(__dirname, 'data');
const DATASET_PATH = path.join(DATASET_DIR, 'financial-qa.parquet');
const DATASET_URL = 'https://huggingface.co/datasets/virattt/financial-qa-10K/resolve/main/data/0.1-00000-of-00001.parquet';

// In-memory cache for the dataset
let financialDataCache = null;
let isInitialized = false;

/**
 * Initialize the financial dataset module
 */
async function initializeFinancialDataset() {
  if (isInitialized) return;
  
  try {
    // Create data directory if it doesn't exist
    if (!fs.existsSync(DATASET_DIR)) {
      fs.mkdirSync(DATASET_DIR, { recursive: true });
    }
    
    // Download the dataset if it doesn't exist
    if (!fs.existsSync(DATASET_PATH)) {
      console.log('Downloading financial dataset from Hugging Face...');
      await downloadDataset();
    }
    
    // Initialize WebAssembly for parquet
    await initWasm();
    
    // Load the dataset into memory
    await loadDataset();
    
    isInitialized = true;
    console.log('Financial dataset initialized successfully');
  } catch (error) {
    console.error('Failed to initialize financial dataset:', error);
    throw error;
  }
}

/**
 * Download the dataset from Hugging Face
 */
async function downloadDataset() {
  try {
    const response = await axios({
      method: 'get',
      url: DATASET_URL,
      responseType: 'arraybuffer'
    });
    
    fs.writeFileSync(DATASET_PATH, Buffer.from(response.data));
    console.log('Financial dataset downloaded successfully');
  } catch (error) {
    console.error('Error downloading financial dataset:', error);
    throw error;
  }
}

/**
 * Load the dataset into memory
 */
async function loadDataset() {
  try {
    const parquetBuffer = fs.readFileSync(DATASET_PATH);
    const arrowTable = readParquet(new Uint8Array(parquetBuffer.buffer));
    financialDataCache = tableFromIPC(arrowTable.intoIPCStream());
    
    console.log(`Loaded financial dataset with ${financialDataCache.numRows} rows`);
  } catch (error) {
    console.error('Error loading financial dataset:', error);
    throw error;
  }
}

/**
 * Get financial QA data related to a specific asset or topic
 * @param {string} query - The search query
 * @param {number} limit - Maximum number of results to return
 * @returns {Array} - Array of relevant QA pairs
 */
async function getFinancialQA(query, limit = 5) {
  if (!isInitialized) {
    await initializeFinancialDataset();
  }
  
  if (!financialDataCache) {
    throw new Error('Financial dataset not loaded');
  }
  
  try {
    // Convert query to lowercase for case-insensitive matching
    const lowerQuery = query.toLowerCase();
    
    // Filter the dataset for relevant QA pairs
    const results = [];
    
    // Iterate through the dataset
    for (let i = 0; i < financialDataCache.numRows && results.length < limit; i++) {
      const row = financialDataCache.get(i);
      
      // Check if the question or answer contains the query
      if (row.question && row.question.toLowerCase().includes(lowerQuery) || 
          row.answer && row.answer.toLowerCase().includes(lowerQuery)) {
        results.push({
          question: row.question,
          answer: row.answer,
          context: row.context || null,
          relevance: calculateRelevance(row.question, row.answer, query)
        });
      }
    }
    
    // Sort by relevance
    results.sort((a, b) => b.relevance - a.relevance);
    
    return results.slice(0, limit);
  } catch (error) {
    console.error('Error querying financial dataset:', error);
    return [];
  }
}

/**
 * Calculate relevance score between query and QA pair
 * @param {string} question - The question
 * @param {string} answer - The answer
 * @param {string} query - The search query
 * @returns {number} - Relevance score (0-1)
 */
function calculateRelevance(question, answer, query) {
  const lowerQuery = query.toLowerCase();
  const lowerQuestion = question.toLowerCase();
  const lowerAnswer = answer.toLowerCase();
  
  // Simple relevance calculation based on term frequency
  const queryTerms = lowerQuery.split(/\s+/);
  let matchCount = 0;
  
  for (const term of queryTerms) {
    if (term.length < 3) continue; // Skip short terms
    
    if (lowerQuestion.includes(term)) matchCount += 2; // Question matches are more important
    if (lowerAnswer.includes(term)) matchCount += 1;
  }
  
  return Math.min(1, matchCount / (queryTerms.length * 3));
}

/**
 * Get financial insights for a specific asset
 * @param {Object} asset - Asset information
 * @returns {Object} - Financial insights
 */
async function getFinancialInsights(asset) {
  if (!isInitialized) {
    await initializeFinancialDataset();
  }
  
  try {
    // Get relevant QA pairs for the asset
    const assetName = asset.name || asset.symbol || '';
    const qaData = await getFinancialQA(assetName, 10);
    
    // Extract insights from QA data
    const insights = {
      keyPoints: extractKeyPoints(qaData),
      riskFactors: extractRiskFactors(qaData),
      marketTrends: extractMarketTrends(qaData),
      qaData: qaData.slice(0, 3) // Include top 3 QA pairs
    };
    
    return insights;
  } catch (error) {
    console.error('Error getting financial insights:', error);
    return {
      keyPoints: [],
      riskFactors: [],
      marketTrends: [],
      qaData: []
    };
  }
}

/**
 * Extract key points from QA data
 * @param {Array} qaData - Array of QA pairs
 * @returns {Array} - Key points
 */
function extractKeyPoints(qaData) {
  const keyPoints = [];
  
  for (const qa of qaData) {
    if (qa.answer && qa.answer.length > 0) {
      // Extract sentences from the answer
      const sentences = qa.answer.split(/[.!?]+/).filter(s => s.trim().length > 20);
      
      // Add the first sentence as a key point if it's not too long
      if (sentences.length > 0 && sentences[0].length < 200) {
        keyPoints.push(sentences[0].trim());
      }
    }
  }
  
  return [...new Set(keyPoints)].slice(0, 5); // Remove duplicates and limit to 5
}

/**
 * Extract risk factors from QA data
 * @param {Array} qaData - Array of QA pairs
 * @returns {Array} - Risk factors
 */
function extractRiskFactors(qaData) {
  const riskFactors = [];
  
  for (const qa of qaData) {
    if (qa.question && qa.question.toLowerCase().includes('risk') && qa.answer) {
      // Extract sentences from the answer
      const sentences = qa.answer.split(/[.!?]+/).filter(s => s.trim().length > 0);
      
      for (const sentence of sentences) {
        if (sentence.toLowerCase().includes('risk') || 
            sentence.toLowerCase().includes('challenge') || 
            sentence.toLowerCase().includes('concern')) {
          riskFactors.push(sentence.trim());
        }
      }
    }
  }
  
  return [...new Set(riskFactors)].slice(0, 3); // Remove duplicates and limit to 3
}

/**
 * Extract market trends from QA data
 * @param {Array} qaData - Array of QA pairs
 * @returns {Array} - Market trends
 */
function extractMarketTrends(qaData) {
  const marketTrends = [];
  
  for (const qa of qaData) {
    if ((qa.question && (
        qa.question.toLowerCase().includes('trend') || 
        qa.question.toLowerCase().includes('market') || 
        qa.question.toLowerCase().includes('growth'))) && qa.answer) {
      
      // Extract sentences from the answer
      const sentences = qa.answer.split(/[.!?]+/).filter(s => s.trim().length > 0);
      
      for (const sentence of sentences) {
        if (sentence.toLowerCase().includes('trend') || 
            sentence.toLowerCase().includes('market') || 
            sentence.toLowerCase().includes('growth') ||
            sentence.toLowerCase().includes('increase') ||
            sentence.toLowerCase().includes('decrease')) {
          marketTrends.push(sentence.trim());
        }
      }
    }
  }
  
  return [...new Set(marketTrends)].slice(0, 3); // Remove duplicates and limit to 3
}

module.exports = {
  initializeFinancialDataset,
  getFinancialQA,
  getFinancialInsights
}; 