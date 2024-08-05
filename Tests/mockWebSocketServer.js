const WebSocket = require('ws');

const server = new WebSocket.Server({ port: 8080 });

server.on('connection', ws => {
  console.log('Client connected');

  // Simulate sending a subscription confirmation
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    result: 1,
    id: 1,
  }));

  // Simulate sending a logsNotification
  setTimeout(() => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'logsNotification',
      params: {
        result: {
          context: {
            slot: 12345
          },
          value: {
            signature: 'mockSigna2bcBCjMsUFBqngDvwoWEFKEY3QARFnt7hwGKFPwqFkCvfbFJjUJWwRZ4xhbk8nW8SiWm6cR1ranTdbdxCsyR9oNHture123',
            err: null,
            logs: [
              "Program ComputeBudget111111111111111111111111111111 invoke [1]",
              "Program ComputeBudget111111111111111111111111111111 success"
            ]
          }
        },
        subscription: 1
      }
    }));
  }, 3000);
});

console.log('Mock WebSocket server is running on ws://localhost:8080');
