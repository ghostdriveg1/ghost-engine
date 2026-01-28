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
 * Fetch chunks in parallel → Decrypt → Decompress → Stream to client
 */
export class DownloadProcessor {
    private githubToken: string;
    private encryptionPass: string;

    constructor(githubToken: string, encryptionPass: string) {
        this.githubToken = githubToken;
        this.encryptionPass = encryptionPass;
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
            'ghostdriveg1',
            process.env.GITHUB_REPO || 'ghost-drive-index',
            this.encryptionPass
        );

        const { data: index } = await indexManager.fetchIndex();

        // Find file metadata
        const file = index.files.find((f) => f.id === fileId);
        if (!file) {
            throw new Error(`File not found: ${fileId}`);
        }

        // Load detached manifest
        const manifest = await this.loadManifest(file.manifest as any);

        // Derive encryption key
        const key = await deriveKey(this.encryptionPass, 'ghost-drive-salt');
        const iv = Buffer.from(file.encryptionIV, 'hex');

        // Get auth tag from first chunk (assuming whole-file encryption)
        const authTag = Buffer.from(manifest.chunks[0].authTag, 'hex');

        // Fetch chunks in parallel (batches of 5)
        const chunkBuffers = await this.fetchChunksParallel(manifest.chunks, 5);

        // Create readable stream from chunk buffers
        const chunkStream = Readable.from(chunkBuffers);

        // Setup streaming pipeline: chunks → decrypt → gunzip → response
        const decryptStream = createDecryptStream(key, iv, authTag);
        const gunzipStream = zlib.createGunzip();

        // Set response headers
        (res as any).setHeader('Content-Type', file.mimeType || 'application/octet-stream');
        (res as any).setHeader('Content-Disposition', `attachment; filename="${file.name}"`);

        // Pipe the streaming download
        chunkStream.pipe(decryptStream).pipe(gunzipStream).pipe(res as any);
    }

    /**
     * Load detached manifest from Index Repo
     * @param manifestPath - Path to manifest file (e.g., "manifests/{uuid}.json")
     */
    private async loadManifest(manifestPath: string): Promise<ChunkManifest> {
        const octokit = createGitHubClient(this.githubToken);

        try {
            const { data } = await octokit.repos.getContent({
                owner: 'ghostdriveg1',
                repo: 'ghost-drive-index',
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
     * Fetch chunks in parallel batches
     * @param chunks - Array of chunk references
     * @param parallelism - Number of chunks to fetch concurrently
     */
    private async fetchChunksParallel(
        chunks: ChunkReference[],
        parallelism: number
    ): Promise<Buffer[]> {
        const results: Buffer[] = [];

        for (let i = 0; i < chunks.length; i += parallelism) {
            const batch = chunks.slice(i, i + parallelism);
            const batchResults = await Promise.all(batch.map((chunk) => this.fetchChunk(chunk)));
            results.push(...batchResults);
        }

        return results;
    }

    /**
     * Fetch a single chunk from shard repository
     * @param chunk - Chunk reference with shard repo and blob SHA
     */
    private async fetchChunk(chunk: ChunkReference): Promise<Buffer> {
        const octokit = createGitHubClient(this.githubToken);

        try {
            const { data } = await octokit.git.getBlob({
                owner: 'ghostdriveg1',
                repo: chunk.shardRepo,
                file_sha: chunk.blobSHA,
            });

            return Buffer.from(data.content, 'base64' as any);
        } catch (error: any) {
            throw new Error(`Failed to fetch chunk from ${chunk.shardRepo}: ${error.message}`);
        }
    }
}
