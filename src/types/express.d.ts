import { Request, Response } from 'express';

declare global {
    namespace Express {
        interface Request {
            githubToken?: string;
            encryptionPass?: string;
        }
    }
}

export { };
