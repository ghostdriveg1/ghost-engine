export interface FileMetadata {
    id: string;
    name: string;
    path: string;
    size: number;
    mimeType: string;
    uploadedAt: string;
    manifest: string; // Path to detached manifest file (e.g., "manifests/{uuid}.json")
    thumbnail?: string;
    encryptionIV: string;
    compressionRatio?: number;
}

export interface ChunkManifest {
    fileId: string;
    chunks: ChunkReference[];
}

export interface ChunkReference {
    shardRepo: string;
    blobSHA: string;
    size: number;
    authTag: string;
}

export interface DatabaseSchema {
    version: string;
    files: FileMetadata[];
    trash: FileMetadata[];
    folders: string[];
    shards: string[];
}
