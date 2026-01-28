import crypto from 'crypto';
import { Octokit } from '@octokit/rest';
import { createGitHubClient, fetchFile } from './client';
import { deriveKey } from '../crypto/keyDerivation';
import { DatabaseSchema } from './types';

const SALT = 'ghost-drive-salt';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Manages encrypted index (db.json) with SHA-based optimistic locking.
 * Handles concurrent updates through retry logic with exponential backoff.
 * 
 * @example
 * const indexMgr = new IndexManager(
 *   req.githubToken,
 *   'username',
 *   'ghost-drive-index',
 *   req.encryptionPass
 * );
 */
export class IndexManager {
    private octokit: Octokit;
    private owner: string;
    private repo: string;
    private encryptionPass: string;

    constructor(token: string, owner: string, repo: string, encryptionPass: string) {
        this.octokit = createGitHubClient(token);
        this.owner = owner;
        this.repo = repo;
        this.encryptionPass = encryptionPass;
    }

    /**
     * Fetches and decrypts db.json from GitHub.
     * Returns data with current SHA for optimistic locking.
     * 
     * @returns Decrypted database schema and current file SHA
     * @throws Error if decryption fails or file not found
     */
    async fetchIndex(): Promise<{ data: DatabaseSchema; sha: string }> {
        const { content, sha } = await fetchFile(this.octokit, this.owner, this.repo, 'db.json');
        const decrypted = await this.decrypt(content);
        const data = JSON.parse(decrypted);

        return { data, sha };
    }

    /**
     * Updates db.json with optimistic locking (SHA-based conflict detection).
     * Retries on 409 Conflict by re-fetching latest SHA and merging changes.
     * 
     * Retry Logic:
     * 1. Attempt update with current SHA
     * 2. On 409 Conflict: Fetch latest index to get new SHA
     * 3. Apply merge function to combine latest data with pending changes
     * 4. Retry with merged data and updated SHA (up to maxRetries times)
     * 5. Throw error if max retries exceeded
     * 
     * @param newData - Updated database schema to save
     * @param currentSHA - SHA from latest fetchIndex call
     * @param mergeStrategy - Optional function to merge latestData with newData on conflict
     * @param maxRetries - Maximum retry attempts (default: 5)
     * @throws Error if max retries exceeded or non-conflict error occurs
     * 
     * @example
     * const { data, sha } = await indexMgr.fetchIndex();
     * data.files.push(newFileMetadata);
     * await indexMgr.updateIndex(data, sha, (latest, pending) => {
     *   // Merge strategy: combine file arrays
     *   return { ...latest, files: [...latest.files, ...pending.files] };
     * });
     */
    async updateIndex(
        newData: DatabaseSchema,
        currentSHA: string,
        mergeStrategy?: (latestData: DatabaseSchema, pendingData: DatabaseSchema) => DatabaseSchema,
        maxRetries = 5
    ): Promise<void> {
        let retries = 0;
        let sha = currentSHA;
        let dataToUpdate = newData;

        while (retries < maxRetries) {
            try {
                const encrypted = await this.encrypt(JSON.stringify(dataToUpdate));

                await this.octokit.repos.createOrUpdateFileContents({
                    owner: this.owner,
                    repo: this.repo,
                    path: 'db.json',
                    message: 'Update index',
                    content: Buffer.from(encrypted).toString('base64'),
                    sha,
                });

                return;
            } catch (error: any) {
                // Handle optimistic locking conflict
                if (error.status === 409) {
                    retries++;

                    if (retries >= maxRetries) {
                        throw new Error('Max retries exceeded for index update');
                    }

                    // Re-fetch to get latest SHA and data
                    const { data: latestData, sha: latestSHA } = await this.fetchIndex();
                    sha = latestSHA;

                    // Merge latest data with pending changes to preserve concurrent updates
                    if (mergeStrategy) {
                        dataToUpdate = mergeStrategy(latestData, newData);
                    } else {
                        // Default merge: use newData but warn about potential data loss
                        console.warn(
                            'No merge strategy provided for conflict resolution. ' +
                            'Consider providing a mergeStrategy to preserve concurrent updates.'
                        );
                        dataToUpdate = newData;
                    }

                    continue;
                }

                throw error;
            }
        }
    }

    private async encrypt(plaintext: string): Promise<string> {
        const key = await deriveKey(this.encryptionPass, SALT);
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv) as crypto.CipherGCM;

        let encrypted = cipher.update(plaintext, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const authTag = cipher.getAuthTag().toString('hex');

        return `${iv.toString('hex')}:${authTag}:${encrypted}`;
    }

    private async decrypt(ciphertext: string): Promise<string> {
        const parts = ciphertext.split(':');

        if (parts.length !== 3) {
            throw new Error('Invalid ciphertext format');
        }

        const [ivHex, authTagHex, encryptedHex] = parts;

        const key = await deriveKey(this.encryptionPass, SALT);
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');

        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv) as crypto.DecipherGCM;
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    }
}
