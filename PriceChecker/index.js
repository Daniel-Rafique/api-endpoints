require('dotenv').config();
const axios = require('axios');

class Api {

    async getTokenAmountForOneSOL(tokenMintAddress) {
        const jupiterApiUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenMintAddress}&amount=1000000000&slippageBps=50&onlyDirectRoutes=true`;

        try {
            const response = await axios.get(jupiterApiUrl);
            const data = response.data;

            if (data && data.data && data.data[0]) {
                const bestRoute = data.data[0]; // Get the best route
                const tokenAmount = bestRoute.outAmount / (10 ** bestRoute.outputDecimals); // Adjust for token decimals

                console.log(`With 1 SOL, you can get approximately ${tokenAmount} tokens of ${tokenMintAddress}`);
                return tokenAmount;
            } else {
                console.error('No routes found for this token.');
            }
        } catch (error) {
            console.error('Error fetching price data from Jupiter:', error);
            throw error;
        }
    }
}

module.exports = Api;
