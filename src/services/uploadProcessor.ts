import { Request } from 'express';
import crypto from 'crypto';
import zlib from 'zlib';
import { deriveKey } from '../crypto/keyDerivation';
import { generateIV, createEncryptStream } from '../crypto/encryption';
import { Chunker } from '../utils/chunker';
import { GitClient } from '../github/gitClient';
import { IndexManager } from '../github/indexManager';
import { ShardManager } from './shardManager';
import { TokenRotator } from './tokenRotator';
import { FileMetadata } from '../github/types';

const BATCH_THRESHOLD = 500 * 1024 * 1024; // 500MB batching threshold

/**
 * UploadProcessor - Orchestrate streaming upload pipeline
 * File → Gzip → Encrypt → Chunk → Stage → Batch Push
 */
export class UploadProcessor {
    private tokenRotator: TokenRotator;
    private encryptionPass: string;
    private owner: string;

    constructor(tokenArray: string[], encryptionPass: string, owner: string) {
        this.tokenRotator = new TokenRotator(tokenArray);
        this.encryptionPass = encryptionPass;
        this.owner = owner;
    }

    /**
     * Process streaming upload with gzip→encrypt→chunk→push pipeline
     * @param req - Express request with file stream
     * @param fileName - Original filename
     * @param estimatedSize - Estimated file size in bytes
     * @returns File ID and total size
     */
    async processUpload(
        req: Request,
        fileName: string,
        estimatedSize: number
    ): Promise<{ fileId: string; size: number }> {
        // Generate file metadata
        const fileId = crypto.randomUUID();
        const iv = generateIV();
        const key = await deriveKey(this.encryptionPass, 'ghost-drive-salt');

        // Get rotated token for this upload
        const currentToken = this.tokenRotator.getNextToken();

        // Select target shard
        const shardManager = new ShardManager(currentToken, this.owner);
        const shardRepo = await shardManager.selectShard(estimatedSize);
        const repoUrl = `https://github.com/${this.owner}/${shardRepo}`;

        // Initialize GitClient with rotated token
        const gitClient = new GitClient(repoUrl, currentToken);

        try {
            await gitClient.initStagingArea();

            // Setup streaming pipeline
            const gzipStream = zlib.createGzip();
            const encryptStream = createEncryptStream(key, iv);
            const chunker = new Chunker();

            // Track chunk metadata
            let chunkCount = 0;
            let totalSize = 0;
            let batchSize = 0;
            const chunkRefs: Array<{ chunkId: string; size: number; position: number; blobSHA: string }> = [];

            // Use backpressure-aware streaming with for-await loop
            const { pipeline } = await import('stream/promises');

            // Pipe: req → gzip → encrypt → chunker
            const streamPromise = pipeline(
                req as any,
                gzipStream,
                encryptStream,
                chunker
            );

            // Process chunks with backpressure awareness
            const chunkProcessing = (async () => {
                for await (const chunk of chunker) {
                    const chunkFilename = `${fileId}-chunk-${chunkCount}.enc`;
                    await gitClient.stageChunk(chunk as Buffer, chunkFilename);

                    // Compute blob SHA for this chunk
                    const blobSHA = crypto.createHash('sha1')
                        .update('blob ' + chunk.length + '\0')
                        .update(chunk as Buffer)
                        .digest('hex');

                    chunkRefs.push({
                        chunkId: `${fileId}-chunk-${chunkCount}`,
                        size: (chunk as Buffer).length,
                        position: chunkCount,
                        blobSHA,
                    });

                    chunkCount++;
                    totalSize += (chunk as Buffer).length;
                    batchSize += (chunk as Buffer).length;

                    // Batch push at 500MB threshold
                    if (batchSize >= BATCH_THRESHOLD) {
                        await gitClient.commitAndPush(`Upload batch for ${fileId}`);
                        await gitClient.clearStagingArea();
                        await gitClient.initStagingArea();
                        batchSize = 0;
                    }
                }
            })();

            // Wait for both stream completion and chunk processing
            await Promise.all([streamPromise, chunkProcessing]);

            // Final batch push for remaining chunks
            if (batchSize > 0) {
                await gitClient.commitAndPush(`Final upload batch for ${fileId}`);
            }

            await gitClient.clearStagingArea();

            // Get auth tag from encryption stream
            const authTag = encryptStream.getAuthTag();

            // Update index with file metadata
            const indexManager = new IndexManager(
                currentToken,
                this.owner,
                process.env.GITHUB_REPO || 'ghost-drive-index',
                this.encryptionPass
            );

            const { data, sha } = await indexManager.fetchIndex();

            const fileMetadata: FileMetadata = {
                id: fileId,
                name: fileName,
                path: `/${fileName}`,
                size: totalSize,
                mimeType: 'application/octet-stream',
                uploadedAt: new Date().toISOString(),
                manifest: {
                    fileId,
                    chunks: chunkRefs.map((ref) => ({
                        shardRepo,
                        blobSHA: ref.blobSHA, // Real blob SHA captured during processing
                        size: ref.size,
                        authTag: authTag.toString('hex'),
                    })),
                },
                encryptionIV: iv.toString('hex'),
            };

            data.files.push(fileMetadata);

            // Update index with merge strategy for concurrent uploads
            await indexManager.updateIndex(
                data,
                sha,
                (latest, pending) => {
                    // Merge strategy: combine file arrays, avoiding duplicates
                    const existingIds = new Set(latest.files.map((f) => f.id));
                    const newFiles = pending.files.filter((f) => !existingIds.has(f.id));
                    return {
                        ...latest,
                        files: [...latest.files, ...newFiles],
                    };
                }
            );

            return { fileId, size: totalSize };
        } catch (error) {
            // Cleanup on error
            await gitClient.clearStagingArea();
            throw error;
        }
    }
}
