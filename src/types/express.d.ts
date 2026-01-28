declare module 'express-serve-static-core' {
    interface Request {
        githubToken?: string;
        encryptionPass?: string;
    }
}
