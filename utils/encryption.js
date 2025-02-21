require('dotenv').config();
const crypto = require('crypto');

// Use the provided encryption key
const IV_LENGTH = 16;
const encryptionKey = process.env.ENCRYPTION_KEY;

class Encryption {
    static encrypt(text) {
        // Validate input
        if (!text || typeof text !== 'string') {
            throw new Error('Invalid input: data must be a non-empty string');
        }

        if (!encryptionKey) {
            throw new Error('Encryption key is not configured');
        }

        try {
            // Generate a random IV for each encryption
            const iv = crypto.randomBytes(IV_LENGTH);

            // Create cipher with the hex key
            const keyBuffer = Buffer.from(encryptionKey, 'hex');
            const cipher = crypto.createCipheriv('aes-256-cbc', keyBuffer, iv);

            // Encrypt the data
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');

            // Combine IV and encrypted data
            return `${iv.toString('hex')}:${encrypted}`;
        } catch (error) {
            console.error('Encryption error details:', {
                error: error.message,
                stack: error.stack,
                inputType: typeof text,
                inputLength: text ? text.length : 0
            });
            throw new Error('Encryption failed: ' + error.message);
        }
    }

    static decrypt(text) {
        try {
            const [ivHex, encryptedHex] = text.split(':');
            const iv = Buffer.from(ivHex, 'hex');
            const encrypted = Buffer.from(encryptedHex, 'hex');

            const keyBuffer = Buffer.from(encryptionKey, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer, iv);
            let decrypted = decipher.update(encrypted);
            decrypted = Buffer.concat([decrypted, decipher.final()]);

            return decrypted.toString('utf8');
        } catch (error) {
            console.error('Decryption error details:', {
                error: error.message,
                stack: error.stack,
                inputType: typeof text,
                inputLength: text?.length,
                hasDelimiter: text?.includes(':'),
                inputSample: text?.substring(0, 30)
            });
            throw new Error(`Decryption failed: ${error.message}`);
        }
    }

    // Helper method to validate encrypted data format
    static isValidEncryptedFormat(text) {
        if (!text || typeof text !== 'string') return false;

        // Check if it's in the new format (with IV)
        if (text.includes(':')) {
            const [ivHex, encryptedHex] = text.split(':');
            return ivHex && encryptedHex &&
                ivHex.length === 32 && // IV length in hex
                /^[0-9a-fA-F]+$/.test(ivHex) &&
                /^[0-9a-fA-F]+$/.test(encryptedHex);
        }

        // Check if it's in the legacy format (without IV)
        return /^[0-9a-fA-F]+$/.test(text);
    }
}

module.exports = Encryption;