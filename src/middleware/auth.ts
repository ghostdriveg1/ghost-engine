import { Request, Response, NextFunction } from 'express';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const githubToken = req.headers['x-ghost-token'] as string | undefined;
    const encryptionPass = req.headers['x-ghost-pass'] as string | undefined;

    if (!githubToken || !encryptionPass) {
        res.status(401).json({
            error: 'Authentication required',
            message: 'Missing x-ghost-token or x-ghost-pass header'
        });
        return;
    }

    req.githubToken = githubToken;
    req.encryptionPass = encryptionPass;

    next();
}
