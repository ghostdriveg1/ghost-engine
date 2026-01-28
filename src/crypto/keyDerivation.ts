import crypto from 'crypto';
import { promisify } from 'util';

const pbkdf2Async = promisify(crypto.pbkdf2);
const keyCache = new Map<string, Buffer>();

const ITERATIONS = 100000;
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

export async function deriveKey(password: string, salt: string): Promise<Buffer> {
    const cacheKey = `${password}:${salt}`;

    const cached = keyCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const derivedKey = await pbkdf2Async(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
    keyCache.set(cacheKey, derivedKey);

    return derivedKey;
}
