import { Octokit } from '@octokit/rest';
import { createGitHubClient } from '../github/client';

const SHARD_THRESHOLD = 900 * 1024 * 1024; // 900MB in bytes

/**
 * ShardManager - Track shard sizes and automatically create new repos at 900MB
 * Initializes from persistent GitHub data to reuse existing shards
 */
export class ShardManager {
    private shardSizes: Map<string, number>;
    private owner: string;
    private token: string;
    private octokit: Octokit;
    private initialized: boolean;

    constructor(token: string, owner: string) {
        this.token = token;
        this.owner = owner;
        this.octokit = createGitHubClient(token);
        this.shardSizes = new Map();
        this.initialized = false;
    }

    /**
     * Initialize shard state from existing GitHub repositories
     */
    private async initializeShardState(): Promise<void> {
        if (this.initialized) return;

        try {
            // Fetch all repositories for the owner
            const { data: repos } = await this.octokit.repos.listForAuthenticatedUser({
                type: 'owner',
                per_page: 100,
            });

            // Filter ghost-drive-shard repos and estimate sizes
            for (const repo of repos) {
                if (repo.name.startsWith('ghost-drive-shard-')) {
                    // Use repo.size (in KB) as initial estimate
                    const sizeInBytes = (repo.size || 0) * 1024;
                    this.shardSizes.set(repo.name, sizeInBytes);
                }
            }

            this.initialized = true;
        } catch (error) {
            console.warn('Failed to initialize shard state from GitHub:', error);
            this.initialized = true; // Continue anyway
        }
    }

    /**
     * Select available shard or create new one when threshold exceeded
     * @param fileSize - Estimated file size in bytes
     * @returns Shard repository name
     */
    async selectShard(fileSize: number): Promise<string> {
        // Ensure shard state is initialized
        await this.initializeShardState();

        // Find existing shard with available space
        for (const [shardName, currentSize] of this.shardSizes.entries()) {
            if (currentSize + fileSize < SHARD_THRESHOLD) {
                // Update size and return shard
                this.shardSizes.set(shardName, currentSize + fileSize);
                return shardName;
            }
        }

        // No available shard found, create new one
        const newShardName = `ghost-drive-shard-${String(this.shardSizes.size + 1).padStart(3, '0')}`;

        // Check if shard exists before creating
        const exists = await this.shardExists(newShardName);
        if (!exists) {
            await this.createShard(newShardName);
        }

        this.shardSizes.set(newShardName, fileSize);
        return newShardName;
    }

    /**
     * Check if a shard repository already exists
     * @param name - Repository name
     */
    private async shardExists(name: string): Promise<boolean> {
        try {
            await this.octokit.repos.get({
                owner: this.owner,
                repo: name,
            });
            return true;
        } catch (error: any) {
            if (error.status === 404) {
                return false;
            }
            throw error;
        }
    }

    /**
     * Create new private shard repository on GitHub
     * @param name - Repository name
     */
    private async createShard(name: string): Promise<void> {
        await this.octokit.repos.createForAuthenticatedUser({
            name,
            private: true,
            auto_init: true,
            description: 'Ghost Drive encrypted chunk storage shard',
        });
    }

    /**
     * Get current shard count
     */
    getShardCount(): number {
        return this.shardSizes.size;
    }

    /**
     * Persist shard sizes (placeholder for future implementation)
     * Could save to index repo or separate metadata store
     */
    async persistShardSizes(): Promise<void> {
        // TODO: Implement persistence to index repo or metadata store
        // For now, state is fetched fresh from GitHub on each initialization
    }
}
