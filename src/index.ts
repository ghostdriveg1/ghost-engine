import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { authMiddleware } from './middleware/auth';
import { IndexManager } from './github/indexManager';
import { GitClient } from './github/gitClient';
import uploadRouter from './routes/upload';
import downloadRouter from './routes/download';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(uploadRouter);
app.use(downloadRouter);

app.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// ============================================
// Integration Test Endpoints
// ============================================

/**
 * Test endpoint: Fetch and display encrypted index
 * Demonstrates IndexManager.fetchIndex() with optimistic locking
 * 
 * Headers required:
 * - x-ghost-token: GitHub Personal Access Token
 * - x-ghost-pass: Encryption password
 */
app.get('/test/fetch-index', authMiddleware, async (req: Request, res: Response) => {
    try {
        const indexMgr = new IndexManager(
            req.githubToken!,
            process.env.GITHUB_OWNER || 'your-username',
            process.env.GITHUB_REPO || 'ghost-drive-index',
            req.encryptionPass!
        );

        const { data, sha } = await indexMgr.fetchIndex();

        res.json({
            success: true,
            sha,
            fileCount: data.files.length,
            data,
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * Test endpoint: Update index with retry logic
 * Demonstrates optimistic locking with SHA-based conflict detection
 * 
 * Body: { "fileName": "test.txt", "fileSize": 1024 }
 */
app.post('/test/update-index', authMiddleware, async (req: Request, res: Response) => {
    try {
        const { fileName, fileSize } = req.body;

        const indexMgr = new IndexManager(
            req.githubToken!,
            process.env.GITHUB_OWNER || 'your-username',
            process.env.GITHUB_REPO || 'ghost-drive-index',
            req.encryptionPass!
        );

        // Fetch current index
        const { data, sha } = await indexMgr.fetchIndex();

        // Add test file metadata
        data.files.push({
            id: `test-${Date.now()}`,
            name: fileName || 'test-file.txt',
            path: `/test/${fileName || 'test-file.txt'}`,
            size: fileSize || 1024,
            mimeType: 'text/plain',
            uploadedAt: new Date().toISOString(),
            manifest: {
                fileId: `test-${Date.now()}`,
                chunks: [],
            },
            encryptionIV: 'test-iv-hex',
        });

        // Update with optimistic locking
        await indexMgr.updateIndex(data, sha);

        res.json({
            success: true,
            message: 'Index updated successfully',
            fileCount: data.files.length,
        });
    } catch (error: any) {
        if (error.message.includes('Max retries exceeded')) {
            res.status(409).json({
                success: false,
                error: 'Concurrent update conflict - max retries exceeded',
            });
        } else {
            res.status(500).json({
                success: false,
                error: error.message,
            });
        }
    }
});

/**
 * Test endpoint: Batch chunk upload simulation
 * Demonstrates GitClient batched upload pattern
 * 
 * Body: { "shardRepo": "ghost-drive-shard-001", "chunkCount": 3 }
 */
app.post('/test/upload-chunks', authMiddleware, async (req: Request, res: Response) => {
    const gitClient = new GitClient(
        `https://github.com/${process.env.GITHUB_OWNER}/${req.body.shardRepo || 'ghost-drive-shard-001'}`,
        req.githubToken!
    );

    try {
        const { shardRepo, chunkCount } = req.body;

        // Initialize staging area
        await gitClient.initStagingArea();

        // Stage test chunks
        const count = chunkCount || 3;
        for (let i = 0; i < count; i++) {
            const testChunk = Buffer.from(`Test chunk ${i} - ${new Date().toISOString()}`);
            await gitClient.stageChunk(testChunk, `test-chunk-${Date.now()}-${i}.enc`);
        }

        // Commit and push batch
        await gitClient.commitAndPush(`Upload ${count} test chunks`);

        res.json({
            success: true,
            message: `Successfully uploaded ${count} chunks in single batch`,
            repo: shardRepo || 'ghost-drive-shard-001',
        });
    } catch (error: any) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    } finally {
        // Always cleanup staging area and PAT-containing git config
        await gitClient.clearStagingArea();
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ghost Engine running on port ${PORT}`);
    console.log(`Server is accessible at http://0.0.0.0:${PORT}`);
});
