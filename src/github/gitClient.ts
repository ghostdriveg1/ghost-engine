import simpleGit, { SimpleGit } from 'simple-git';
import fs from 'fs/promises';
import path from 'path';

const STAGING_DIR = '/tmp/ghost-staging';

/**
 * Git Protocol client for batched chunk uploads.
 * Uses local staging area to batch multiple chunks into single push.
 * Reduces API calls by ~95% (1 push per 500MB vs 1 per 24MB).
 * 
 * @example
 * const gitClient = new GitClient(
 *   'https://github.com/user/ghost-drive-shard-001',
 *   req.githubToken
 * );
 * await gitClient.initStagingArea();
 * await gitClient.stageChunk(chunk1, 'chunk-uuid1.enc');
 * await gitClient.stageChunk(chunk2, 'chunk-uuid2.enc');
 * await gitClient.commitAndPush('Upload batch');
 * await gitClient.clearStagingArea();
 */
export class GitClient {
    private git: SimpleGit;
    private repoUrl: string;
    private token: string;

    constructor(repoUrl: string, token: string) {
        this.repoUrl = repoUrl;
        this.token = token;
        this.git = simpleGit();
    }

    /**
     * Initializes local Git repository in /tmp/ghost-staging.
     * Deletes existing directory to avoid stale files.
     * Sets up authenticated remote and creates main branch.
     * 
     * @throws Error if directory creation or Git init fails
     */
    async initStagingArea(): Promise<void> {
        // Delete existing staging directory to avoid stale files and retained PAT
        await fs.rm(STAGING_DIR, { recursive: true, force: true });

        // Create fresh staging directory
        await fs.mkdir(STAGING_DIR, { recursive: true });

        this.git = simpleGit(STAGING_DIR);
        await this.git.init();

        const authenticatedUrl = this.repoUrl.replace('https://', `https://${this.token}@`);

        // Try to add remote, if it exists, remove and re-add
        try {
            await this.git.addRemote('origin', authenticatedUrl);
        } catch (error: any) {
            if (error.message?.includes('already exists')) {
                await this.git.removeRemote('origin');
                await this.git.addRemote('origin', authenticatedUrl);
            } else {
                throw error;
            }
        }

        // Explicitly set branch to main
        await this.git.checkoutLocalBranch('main');
    }

    /**
     * Stages an encrypted chunk for batched upload.
     * Chunk is written to staging directory but NOT pushed yet.
     * 
     * @param chunkData - Encrypted chunk buffer
     * @param filename - UUID-based filename (e.g., 'chunk-{uuid}.enc')
     */
    async stageChunk(chunkData: Buffer, filename: string): Promise<void> {
        const filePath = path.join(STAGING_DIR, filename);
        await fs.writeFile(filePath, chunkData);
    }

    /**
     * Commits and pushes all staged chunks in a single Git operation.
     * Batching strategy: Execute when 500MB or 20 chunks accumulated.
     * 
     * @param message - Git commit message
     * @throws Error if Git operations fail
     */
    async commitAndPush(message: string): Promise<void> {
        await this.git.add('.');
        await this.git.commit(message);
        await this.git.push('origin', 'main');
    }

    /**
     * Removes staging directory and all staged chunks.
     * Should be called after successful push or on error cleanup.
     */
    async clearStagingArea(): Promise<void> {
        await fs.rm(STAGING_DIR, { recursive: true, force: true });
    }
}
