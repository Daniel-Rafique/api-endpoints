const { formatDiscordMessage } = require('./utils');
const { EmbedBuilder } = require('discord.js');


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

const formatDiscordMessage = (content) => {
    // Handle null or undefined content
    if (!content) {
        return { content: '' };
    }

    // Format components
    const components = formatDiscordComponents(content.components);

    // Format embeds
    const embeds = formatDiscordEmbeds(content.embeds);

    // Return formatted message payload
    return {
        ...content,
        components,
        embeds,
        allowed_mentions: content.allowed_mentions || { parse: [] }
    };
};

const sendDiscordMessage = async (interaction, content) => {
    try {
        if (!interaction?.token || !'1286051782073647185') {
            console.error('Missing required Discord credentials');
            throw new Error('Missing required Discord credentials');
        }

        const messagePayload = formatDiscordMessage(content);

        // Debug log before sending
        console.log('Sending formatted message payload:', JSON.stringify(messagePayload, null, 2));

        const webhookUrl = `https://discord.com/api/v10/webhooks/1286051782073647185/${interaction.token}`;

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                'User-Agent': 'DiscordBot (https://github.com/koynlabs/market-maker, 1.0.0)'
            },
            body: JSON.stringify(messagePayload)
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Discord API Error Response:', JSON.stringify(errorData));
            throw new Error(`Discord API error: ${response.status} - ${JSON.stringify(errorData)}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Discord webhook error:', error);
        throw error;
    }
};

module.exports = {
    sendDiscordMessage
};