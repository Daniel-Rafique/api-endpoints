require('dotenv').config();
const fs = require('fs');
const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 443; // Use port 443 for HTTPS

// SSL options
const options = {
    key: fs.readFileSync('/etc/letsencrypt/live/bot.koynlabs.com/privkey.pem'),
    cert: fs.readFileSync('/etc/letsencrypt/live/bot.koynlabs.com/fullchain.pem')
};

app.use(bodyParser.json());

// Endpoint to handle incoming POST requests
app.post('/api/start', (req, res) => {
    const { chatId, boostType } = req.body;

    if (!chatId || !boostType) {
        return res.status(400).send('Missing chatId or boostType');
    }

    // Perform the necessary actions with chatId and boostType
    console.log(`Received chatId: ${chatId}, boostType: ${boostType}`);

    // Example action: Log the data (Replace with your logic)
    // You can integrate this with your market maker logic here

    res.status(200).send('Data received successfully');
});

// Start the HTTPS server
https.createServer(options, app).listen(port, () => {
    console.log(`HTTPS server is running on port ${port}`);
});
