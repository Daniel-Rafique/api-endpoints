const dataManager = require('./database');
const BalanceChecker = require('./BalanceChecker');

// Create a test instance
const checker = new BalanceChecker('test-chat-id', 'test-key', 0.1, 1000, 'test-mint', 'telegram', null, {});

// Test the event
dataManager.setMode('test-chat-id', 'sniper')
  .then(() => {
    console.log('Mode set successfully');
  })
  .catch(console.error); 