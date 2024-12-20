const axios = require('axios');

class Discord {
    constructor(discordToken) {
        this.discordApiUrl = 'https://discord.com/api/v10/webhooks';
        this.discordToken = discordToken;
    }

    async sendDiscordMessage(interaction, content) {
        try {
            // Format the message content
            const messagePayload = typeof content === 'string' ? { content } : content;

            // Add ephemeral flag if not explicitly set
            if (!messagePayload.flags) {
                messagePayload.flags = 64; // Ephemeral flag
            }

            // Send message using axios
            const response = await axios.post(
                `${this.discordApiUrl}/${interaction.application_id}/${interaction.token}`,
                messagePayload,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bot ${this.discordToken}`
                    }
                }
            );

            return response.data;

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

