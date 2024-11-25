const WebSocket = require('ws');
const EventEmitter = require('events');

class PriceChecker extends EventEmitter {
    constructor() {
        super();
        this.bitqueryConnection = null;
        this.isConnected = false;
        this.maxRetries = 3;
        this.retryDelay = 5000;
        this.connectionPromise = null;
    }

    async connectToBitquery(token) {
        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        this.connectionPromise = new Promise((resolve, reject) => {
            this.bitqueryConnection = new WebSocket(
                "wss://streaming.bitquery.io/eap?token=" + token,
                "graphql-ws",
                {
                    headers: {
                        "Content-Type": "application/json",
                    }
                }
            );

            const connectionTimeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
                this.cleanup();
            }, 60000);

            this.bitqueryConnection.on("open", () => {
                console.log("Connected to Bitquery Quote WebSocket");
                this.isConnected = true;
                const initMessage = JSON.stringify({ type: "connection_init", payload: {} });
                this.bitqueryConnection.send(initMessage);
            });

            this.bitqueryConnection.on("message", (data) => {
                const response = JSON.parse(data);
                console.log('Received message:', response);
                if (response.type === "connection_ack") {
                    console.log("Connection acknowledged by Bitquery");
                    clearTimeout(connectionTimeout);
                    this.emit('connected');
                    resolve(true);
                }
                if (response.type === "data") {
                    this.emit('quoteUpdate', response.payload.data);
                }
                if (response.type === "error") {
                    console.error("Received error from Bitquery:", response);
                    this.emit('error', new Error(response.payload));
                }
            });

            this.bitqueryConnection.on("close", () => {
                console.log("Bitquery WebSocket connection closed");
                this.cleanup();
                reject(new Error('WebSocket closed'));
            });

            this.bitqueryConnection.on("error", (error) => {
                console.error("Bitquery WebSocket error:", error);
                this.cleanup();
                reject(error);
            });
        });

        return this.connectionPromise;
    }

    async getTokenAmountForOneSOL(token, tokenMintAddress) {
        let retryCount = 0;

        while (retryCount < this.maxRetries) {
            try {
                if (!this.isConnected) {
                    await this.connectToBitquery(token);
                }

                return await new Promise((resolve, reject) => {
                    const query = `
                        query {
                            Solana {
                                DEXTradeByTokens(
                                    limit: {count: 1}
                                    where: {
                                        Trade: {
                                            Side: {Currency: {MintAddress: {is: "So11111111111111111111111111111111111111112"}}}, 
                                            Currency: {MintAddress: {is: "${tokenMintAddress}"}}
                                        }
                                    }
                                ) {
                                    Trade {
                                        Currency {
                                            MintAddress
                                            Name
                                            Symbol
                                        }
                                        Price
                                        Side {
                                            Currency {
                                                Name
                                                MintAddress
                                                Symbol
                                            }
                                            Amount
                                            AmountInUSD
                                        }
                                        Amount
                                        AmountInUSD
                                    }
                                }
                            }
                        }
                    `;

                    const subscriptionMessage = JSON.stringify({
                        type: "start",
                        id: `quote_${tokenMintAddress}`, // Ensure ID is a string by using string template
                        payload: { query }
                    });

                    const queryTimeout = setTimeout(() => {
                        cleanup();
                        reject(new Error('Quote query timeout'));
                    }, 30000);

                    const cleanup = () => {
                        this.removeListener('quoteUpdate', onQuoteUpdate);
                        this.removeListener('error', onError);
                        clearTimeout(queryTimeout);
                    };

                    const onQuoteUpdate = (data) => {
                        console.log("Received quote update:", data);

                        const trade = data?.Solana?.DEXTradeByTokens?.[0]?.Trade;
                        if (trade) {
                            const price = parseFloat(trade.Price);
                            // Calculate tokens per 1 SOL: 1 SOL / price per token
                            const tokensPerSOL = 1 / price;

                            console.log('Price calculation:', {
                                price,
                                tokensPerSOL,
                                rawPrice: trade.Price
                            });

                            cleanup();
                            resolve(Math.ceil(tokensPerSOL));
                        } else {
                            cleanup();
                            reject(new Error('No trade data found'));
                        }
                    };

                    const onError = (error) => {
                        cleanup();
                        reject(error);
                    };

                    this.on('quoteUpdate', onQuoteUpdate);
                    this.once('error', onError);

                    if (this.bitqueryConnection.readyState === WebSocket.OPEN) {
                        this.bitqueryConnection.send(subscriptionMessage);
                    } else {
                        cleanup();
                        reject(new Error('WebSocket not open'));
                    }
                });

            } catch (error) {
                console.error(`Quote fetch attempt ${retryCount + 1} failed:`, error);
                this.cleanup();
                retryCount++;

                if (retryCount < this.maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                } else {
                    throw new Error(`Failed to fetch quote after ${this.maxRetries} attempts`);
                }
            }
        }
    }

    cleanup() {
        this.isConnected = false;
        this.connectionPromise = null;
        if (this.bitqueryConnection) {
            this.bitqueryConnection.removeAllListeners();
            this.bitqueryConnection = null;
        }
        this.emit('disconnected');
    }
}

module.exports = PriceChecker;
