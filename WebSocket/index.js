const WebSocket = require('ws');

class SolanaWebSocketListener {
  constructor(endpoint, publicKey, onMessage) {
    this.endpoint = endpoint;
    this.publicKey = publicKey;
    this.onMessage = onMessage;
    this.ws = null;
    this.pingInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectTimeout = null;
    this.dummyPublicKey = '2E5btHk6WtUASSiEzfBxRFEQUvNV8aX2FV4Zv3TyXn8M';
  }

  connect() {
    console.log('Connecting to WebSocket endpoint:', this.endpoint);
    this.ws = new WebSocket(this.endpoint);

    this.ws.on('open', () => {
      console.log('WebSocket connection successfully opened');
      this.subscribe();
      this.startPingInterval();
    });

    this.ws.on('message', (data) => {
      const response = JSON.parse(data);
      console.log('Received WebSocket message:', response);
      if (response.method === 'logsNotification') {
        const transactionSignature = response.params.result.value.signature;
        if (transactionSignature) {
          this.onMessage(transactionSignature);
        }
      }
    });

    this.ws.on('close', () => {
      console.log('WebSocket connection closed');
      this.clearPingInterval();
      this.reconnect();
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.clearPingInterval();
      this.reconnect();
    });
  }

  subscribe() {
    const subscribeMessage = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [this.publicKey]
        },
        {
          commitment: "confirmed"
        }
      ]
    });
    this.ws.send(subscribeMessage);
    console.log('Subscription message sent:', subscribeMessage);
  }

  startPingInterval() {
    this.pingInterval = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) {
        console.log('Sending ping to WebSocket server');
        this.ws.ping();
      }
    }, 30000); // Ping every 30 seconds
  }

  clearPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  reconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      console.log(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);
      this.reconnectTimeout = setTimeout(() => {
        this.connect();
      }, delay);
    } else {
      console.error('Max reconnection attempts reached. Please check your connection and restart the application.');
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
    this.clearPingInterval();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
  }
}

module.exports = SolanaWebSocketListener;