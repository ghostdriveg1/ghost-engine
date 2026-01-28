import express, { Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { UploadProcessor } from '../services/uploadProcessor';
import busboy from 'busboy';

const router = express.Router();

/**
 * POST /upload - Streaming file upload endpoint
 * Headers required:
 * - x-ghost-token: GitHub Personal Access Token (fallback auth)
 * - x-ghost-pass: Encryption password
 * 
 * Environment variables:
 * - GITHUB_TOKENS: Comma-separated list of GitHub PATs for rotation
 */
router.post('/upload', authMiddleware, async (req: Request, res: Response) => {
    try {
        const bb = busboy({ headers: (req as any).headers });
        let fileName = 'unknown';
        let uploadComplete = false;

        bb.on('file', async (fieldname: string, file: any, info: any) => {
            fileName = info.filename;

            // Parse token array from environment or fallback to single header token
            const tokenString = process.env.GITHUB_TOKENS || (req as any).githubToken || '';
            const tokenArray = tokenString.split(',').map((t: string) => t.trim()).filter((t: string) => t);

            if (tokenArray.length === 0) {
                if (!uploadComplete) {
                    (res as any).status(401).json({
                        success: false,
                        error: 'No GitHub tokens available. Set GITHUB_TOKENS environment variable or provide x-ghost-token header.',
                    });
                }
                return;
            }

            const processor = new UploadProcessor(
                tokenArray,
                (req as any).encryptionPass!,
                process.env.GITHUB_OWNER || 'ghostdriveg1'
            );

            try {
                // Estimate size from content-length header if available
                const estimatedSize = parseInt(((req as any).headers)['content-length'] || '0');

                const result = await processor.processUpload(file as any, fileName, estimatedSize);

                uploadComplete = true;
                (res as any).json({
                    success: true,
                    fileId: result.fileId,
                    size: result.size,
                });
            } catch (error: any) {
                if (!uploadComplete) {
                    (res as any).status(500).json({
                        success: false,
                        error: error.message,
                    });
                }
            }
        });

        bb.on('error', (error: any) => {
            if (!uploadComplete) {
                (res as any).status(500).json({
                    success: false,
                    error: error.message,
                });
            }
        });

        (req as any).pipe(bb);
    } catch (error: any) {
        (res as any).status(500).json({
            success: false,
            error: error.message,
        });
    }
});

export default router;
