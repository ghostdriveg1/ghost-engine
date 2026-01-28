import express, { Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { DownloadProcessor } from '../services/downloadProcessor';

const router = express.Router();

/**
 * GET /download/:fileId - Streaming file download endpoint
 * Headers required:
 * - x-ghost-token: GitHub Personal Access Token
 * - x-ghost-pass: Encryption password
 */
router.get('/download/:fileId', authMiddleware, async (req: Request, res: Response) => {
    try {
        const { fileId } = (req as any).params;

        const processor = new DownloadProcessor(
            (req as any).githubToken!,
            (req as any).encryptionPass!,
            process.env.GITHUB_OWNER || 'ghostdriveg1',
            process.env.GITHUB_REPO || 'ghost-drive-index'
        );

        await processor.streamDownload(fileId, res);
    } catch (error: any) {
        (res as any).status(500).json({
            success: false,
            error: error.message,
        });
    }
});

export default router;
