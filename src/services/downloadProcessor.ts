import { Response } from 'express';
import crypto from 'crypto';
import zlib from 'zlib';
import { Readable } from 'stream';
import { deriveKey } from '../crypto/keyDerivation';
import { createDecryptStream } from '../crypto/encryption';
import { IndexManager } from '../github/indexManager';
import { createGitHubClient } from '../github/client';
import { ChunkManifest, ChunkReference } from '../github/types';

/**
 * DownloadProcessor - Orchestrate streaming download pipeline
 * Fetch chunks incrementally → Decrypt → Decompress → Stream to client
 */
export class DownloadProcessor {
    private githubToken: string;
    private encryptionPass: string;
    private owner: string;
    private indexRepo: string;

    constructor(githubToken: string, encryptionPass: string, owner: string, indexRepo: string) {
        this.githubToken = githubToken;
        this.encryptionPass = encryptionPass;
        this.owner = owner;
        this.indexRepo = indexRepo;
    }

    /**
     * Stream file download with decrypt→decompress pipeline
     * @param fileId - File UUID to download
     * @param res - Express response object
     */
    async streamDownload(fileId: string, res: Response): Promise<void> {
        // Fetch and decrypt index
        const indexManager = new IndexManager(
            this.githubToken,
            this.owner,
            this.indexRepo,
            this.encryptionPass
        );

        const { data: index } = await indexManager.fetchIndex();

        // Find file metadata
        const file = index.files.find((f) => f.id === fileId);
        if (!file) {
            throw new Error(`File not found: ${fileId}`);
        }

        // Load detached manifest
        const manifest = await this.loadManifest(file.manifest);

        // Derive encryption key
        const key = await deriveKey(this.encryptionPass, 'ghost-drive-salt');
        const iv = Buffer.from(file.encryptionIV, 'hex');

        // Get auth tag from first chunk (assuming whole-file encryption)
        const authTag = Buffer.from(manifest.chunks[0].authTag, 'hex');

        // Set response headers
        (res as any).setHeader('Content-Type', file.mimeType || 'application/octet-stream');
        (res as any).setHeader('Content-Disposition', `attachment; filename="${file.name}"`);

        // Create decrypt and gunzip streams
        const decryptStream = createDecryptStream(key, iv, authTag);
        const gunzipStream = zlib.createGunzip();

        // Pipe decrypt → gunzip → response
        decryptStream.pipe(gunzipStream).pipe(res as any);

        // Stream chunks incrementally to decrypt stream
        await this.streamChunksIncremental(manifest.chunks, decryptStream, 5);
    }

    /**
     * Load detached manifest from Index Repo
     * @param manifestPath - Path to manifest file (e.g., "manifests/{uuid}.json")
     */
    private async loadManifest(manifestPath: string): Promise<ChunkManifest> {
        const octokit = createGitHubClient(this.githubToken);

        try {
            const { data } = await octokit.repos.getContent({
                owner: this.owner,
                repo: this.indexRepo,
                path: manifestPath,
            });

            if ('content' in data) {
                const content = Buffer.from(data.content, 'base64').toString('utf-8');
                return JSON.parse(content);
            }

            throw new Error('Manifest file not found or invalid format');
        } catch (error: any) {
            throw new Error(`Failed to load manifest: ${error.message}`);
        }
    }

    /**
     * Stream chunks incrementally to avoid buffering entire file
     * Fetches chunks in batches of parallelism while streaming to decrypt stream
     * @param chunks - Array of chunk references
     * @param targetStream - Writable stream to pipe chunks into
     * @param parallelism - Number of chunks to fetch concurrently
     */
    private async streamChunksIncremental(
        chunks: ChunkReference[],
        targetStream: NodeJS.WritableStream,
        parallelism: number
    ): Promise<void> {
        for (let i = 0; i < chunks.length; i += parallelism) {
            const batch = chunks.slice(i, i + parallelism);
            const batchBuffers = await Promise.all(batch.map((chunk) => this.fetchChunk(chunk)));

            // Write each chunk buffer to the target stream
            for (const buffer of batchBuffers) {
                if (!targetStream.write(buffer)) {
                    // Wait for drain event if backpressure occurs
                    await new Promise((resolve) => targetStream.once('drain', resolve));
                }
            }
        }

        // Signal end of input
        targetStream.end();
    }

    /**
     * Fetch a single chunk from shard repository
     * @param chunk - Chunk reference with shard repo and blob SHA
     */
    private async fetchChunk(chunk: ChunkReference): Promise<Buffer> {
        const octokit = createGitHubClient(this.githubToken);

        try {
            const { data } = await octokit.git.getBlob({
                owner: this.owner,
                repo: chunk.shardRepo,
                file_sha: chunk.blobSHA,
            });

            return Buffer.from(data.content, 'base64' as any);
        } catch (error: any) {
            throw new Error(`Failed to fetch chunk from ${chunk.shardRepo}: ${error.message}`);
        }
    }
}
