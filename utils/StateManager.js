class StateManager {
    constructor(balanceChecker) {
      this.balanceChecker = balanceChecker;
    }
  
    enableListener() {
      this.balanceChecker.listenerActive = true;
      if (!this.balanceChecker.ws || this.balanceChecker.ws.readyState === WebSocket.CLOSED) {
        this.balanceChecker.listenForTransactions();
      }
    }
  
    disableListener() {
      this.balanceChecker.listenerActive = false;
      if (this.balanceChecker.ws) {
        this.balanceChecker.ws.close();
      }
      clearInterval(this.balanceChecker.pingInterval);
      clearInterval(this.balanceChecker.reconnectInterval);
    }
  }
  
  module.exports = StateManager;  