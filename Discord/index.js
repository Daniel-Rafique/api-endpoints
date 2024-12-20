const axios = require('axios');

class Discord {
    constructor(discordToken) {
        this.discordApiUrl = 'https://discord.com/api/v10/webhooks';
        this.discordToken = discordToken;
    }

    async sendDiscordMessage(content, embeds = [], components = []) {
        try {
            const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content,
                    embeds,
                    components
                })
            });

            if (!response.ok) {
                throw new Error(`Discord webhook error: ${response.statusText}`);
            }
            console.log('Discord message sent successfully');
        } catch (error) {
            console.error('Error sending Discord message:', error);
            throw error;
        }
    }
}


const formatDiscordComponents = (components) => {
    if (!components) return [];

    // If components is a function, execute it
    if (typeof components === 'function') {
        components = components();
    }

    // If components is an array, process each component
    if (Array.isArray(components)) {
        return components.map(row => {
            // If row is ActionRowBuilder, convert to JSON
            if (row && typeof row.toJSON === 'function') {
                return row.toJSON();
            }
            return row;
        });
    }

    // If single component (like ModalBuilder), convert to JSON
    if (components && typeof components.toJSON === 'function') {
        return [components.toJSON()];
    }

    return [];
};

const formatDiscordEmbeds = (embeds) => {
    if (!embeds) return [];

    // If embeds is not an array, wrap it in an array
    const embedArray = Array.isArray(embeds) ? embeds : [embeds];

    // Process each embed
    return embedArray.map(embed => {
        // If embed is already a plain object, return it
        if (embed && typeof embed === 'object' && !Array.isArray(embed)) {
            return embed;
        }
        // If embed is an EmbedBuilder, convert to JSON
        if (embed && typeof embed.toJSON === 'function') {
            return embed.toJSON();
        }
        // If embed is an array (nested), take the first object
        if (Array.isArray(embed)) {
            return embed[0];
        }
        return embed;
    }).filter(Boolean); // Remove any null/undefined values
};

module.exports = Discord;

