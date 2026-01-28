import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export function createEncryptStream(key: Buffer, iv: Buffer): crypto.CipherGCM {
    return crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;
}

export function createDecryptStream(key: Buffer, iv: Buffer, authTag: Buffer): crypto.DecipherGCM {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv) as crypto.DecipherGCM;
    decipher.setAuthTag(authTag);
    return decipher;
}

export function generateIV(): Buffer {
    return crypto.randomBytes(IV_LENGTH);
}
