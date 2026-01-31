// ============================================
// Ghost Engine - Cloudflare Worker
// ============================================

// Constants
const CHUNK_SIZE = 24 * 1024 * 1024; // 24MB
const SHARD_SIZE_LIMIT = 900 * 1024 * 1024; // 900MB
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_SALT = 'ghost-drive-salt';
const IV_LENGTH = 12;
const MAX_RETRIES = 5;
const PARALLEL_DOWNLOADS = 5;

// CORS headers
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': 'https://ghost-ui.pages.dev',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-ghost-token, x-ghost-pass',
    'Access-Control-Max-Age': '86400',
};

// ============================================
// Main Worker Entry Point
// ============================================

export default {
    async fetch(request, env) {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // Route requests
            if (path === '/health' && request.method === 'GET') {
                return handleHealth();
            }

            if (path === '/upload' && request.method === 'POST') {
                return await handleUpload(request, env);
            }

            if (path.startsWith('/download/') && request.method === 'GET') {
                const fileId = path.split('/')[2];
                return await handleDownload(fileId, request, env);
            }

            return jsonResponse({ error: 'Not found' }, 404);
        } catch (error) {
            console.error('Worker error:', error);
            return jsonResponse({ error: error.message }, 500);
        }
    },
};

// ============================================
// Crypto Functions (Web Crypto API)
// ============================================

async function deriveKey(password) {
    const enc = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
        'raw',
        enc.encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
    );

    return await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: enc.encode(PBKDF2_SALT),
            iterations: PBKDF2_ITERATIONS,
            hash: 'SHA-256',
        },
        passwordKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptData(data, key) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        data
    );

    // Prepend IV to encrypted data
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    return result;
}

async function decryptData(encryptedData, key) {
    const iv = encryptedData.slice(0, IV_LENGTH);
    const data = encryptedData.slice(IV_LENGTH);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        data
    );

    return new Uint8Array(decrypted);
}

// ============================================
// GitHub API Functions
// ============================================

async function fetchIndex(token, owner, repo, password) {
    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/db.json`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
        }
    );

    if (!response.ok) {
        if (response.status === 404) {
            // Index doesn't exist yet, return empty
            return { data: { files: [] }, sha: null };
        }
        throw new Error(`Failed to fetch index: ${response.statusText}`);
    }

    const json = await response.json();
    const content = base64Decode(json.content.replace(/\n/g, ''));

    // Decrypt index
    const key = await deriveKey(password);
    const decrypted = await decryptData(content, key);
    const data = JSON.parse(new TextDecoder().decode(decrypted));

    return { data, sha: json.sha };
}

async function updateIndex(token, owner, repo, password, data, sha) {
    const key = await deriveKey(password);
    const jsonStr = JSON.stringify(data);
    const encrypted = await encryptData(new TextEncoder().encode(jsonStr), key);
    const content = base64Encode(encrypted);

    let retries = 0;
    while (retries < MAX_RETRIES) {
        const body = {
            message: 'Update index',
            content,
            ...(sha && { sha }),
        };

        const response = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/contents/db.json`,
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }
        );

        if (response.ok) {
            return await response.json();
        }

        if (response.status === 409) {
            // Conflict - retry with fresh SHA
            retries++;
            const fresh = await fetchIndex(token, owner, repo, password);

            // Merge strategy: combine file arrays
            const merged = {
                files: [...fresh.data.files, ...data.files.filter(
                    f => !fresh.data.files.find(existing => existing.id === f.id)
                )],
            };

            data = merged;
            sha = fresh.sha;
            continue;
        }

        throw new Error(`Failed to update index: ${response.statusText}`);
    }

    throw new Error('Max retries exceeded for index update');
}

async function uploadChunk(token, owner, repo, path, chunk) {
    const content = base64Encode(chunk);

    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: `Upload chunk ${path}`,
                content,
            }),
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to upload chunk: ${response.statusText}`);
    }

    const json = await response.json();
    return json.content.sha;
}

async function downloadChunk(token, owner, repo, sha) {
    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to download chunk: ${response.statusText}`);
    }

    const json = await response.json();
    return base64Decode(json.content);
}

async function writeManifest(token, owner, repo, fileId, manifest) {
    const content = base64Encode(new TextEncoder().encode(JSON.stringify(manifest)));

    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/manifests/${fileId}.json`,
        {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: `Create manifest for ${fileId}`,
                content,
            }),
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to write manifest: ${response.statusText}`);
    }
}

async function loadManifest(token, owner, repo, fileId) {
    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/manifests/${fileId}.json`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to load manifest: ${response.statusText}`);
    }

    const json = await response.json();
    const content = base64Decode(json.content.replace(/\n/g, ''));
    return JSON.parse(new TextDecoder().decode(content));
}

// ============================================
// Shard Management
// ============================================

async function selectShard(token, owner) {
    // Fetch existing shard repos
    const response = await fetch(
        `https://api.github.com/users/${owner}/repos?per_page=100`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to fetch repos: ${response.statusText}`);
    }

    const repos = await response.json();
    const shards = repos.filter(r => r.name.startsWith('ghost-drive-shard-'));

    // Find shard with available space (simplified - assumes under limit)
    if (shards.length > 0) {
        return shards[0].name;
    }

    // Create new shard
    const shardNumber = String(shards.length + 1).padStart(3, '0');
    const shardName = `ghost-drive-shard-${shardNumber}`;

    const createResponse = await fetch(
        'https://api.github.com/user/repos',
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: shardName,
                private: true,
                description: 'Ghost Drive storage shard',
            }),
        }
    );

    if (!createResponse.ok) {
        throw new Error(`Failed to create shard: ${createResponse.statusText}`);
    }

    return shardName;
}

// ============================================
// Token Rotation
// ============================================

function getRotatedToken(env, index = 0) {
    const tokens = env.GITHUB_TOKEN.split(',');
    return tokens[index % tokens.length].trim();
}

// ============================================
// Upload Handler
// ============================================

async function handleUpload(request, env) {
    const token = request.headers.get('x-ghost-token') || getRotatedToken(env);
    const password = request.headers.get('x-ghost-pass');

    if (!password) {
        return jsonResponse({ error: 'Missing x-ghost-pass header' }, 400);
    }

    const owner = env.GITHUB_OWNER || 'ghostdriveg1';
    const indexRepo = env.GITHUB_INDEX_REPO || 'ghost-drive-index';

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
        return jsonResponse({ error: 'No file provided' }, 400);
    }

    const fileId = generateUUID();
    const fileName = file.name;
    const fileSize = file.size;
    const mimeType = file.type;

    // Derive encryption key
    const key = await deriveKey(password);

    // Process file: compress -> encrypt -> chunk -> upload
    const chunks = [];
    const buffer = await file.arrayBuffer();

    // Compress
    const compressed = await compressData(new Uint8Array(buffer));

    // Encrypt
    const encrypted = await encryptData(compressed, key);
    const iv = encrypted.slice(0, IV_LENGTH);

    // Split into chunks
    let offset = 0;
    let chunkIndex = 0;

    while (offset < encrypted.length) {
        const chunkData = encrypted.slice(offset, offset + CHUNK_SIZE);
        const shard = await selectShard(token, owner);
        const chunkPath = `chunks/${fileId}/${chunkIndex}.enc`;

        const blobSha = await uploadChunk(token, owner, shard, chunkPath, chunkData);

        chunks.push({
            id: `${fileId}-${chunkIndex}`,
            position: chunkIndex,
            size: chunkData.length,
            blobSha,
            shardRepo: shard,
        });

        offset += CHUNK_SIZE;
        chunkIndex++;
    }

    // Write manifest
    const manifest = {
        fileId,
        chunks,
    };
    await writeManifest(token, owner, indexRepo, fileId, manifest);

    // Update index
    const { data, sha } = await fetchIndex(token, owner, indexRepo, password);

    data.files.push({
        id: fileId,
        name: fileName,
        path: `/${fileName}`,
        size: fileSize,
        mimeType,
        uploadedAt: new Date().toISOString(),
        manifest: JSON.stringify(manifest),
        encryptionIV: base64Encode(iv),
    });

    await updateIndex(token, owner, indexRepo, password, data, sha);

    return jsonResponse({
        success: true,
        fileId,
        size: fileSize,
    });
}

// ============================================
// Download Handler
// ============================================

async function handleDownload(fileId, request, env) {
    const token = request.headers.get('x-ghost-token') || getRotatedToken(env);
    const password = request.headers.get('x-ghost-pass');

    if (!password) {
        return jsonResponse({ error: 'Missing x-ghost-pass header' }, 400);
    }

    const owner = env.GITHUB_OWNER || 'ghostdriveg1';
    const indexRepo = env.GITHUB_INDEX_REPO || 'ghost-drive-index';

    // Fetch index to find file metadata
    const { data } = await fetchIndex(token, owner, indexRepo, password);
    const file = data.files.find(f => f.id === fileId);

    if (!file) {
        return jsonResponse({ error: 'File not found' }, 404);
    }

    // Load manifest
    const manifest = await loadManifest(token, owner, indexRepo, fileId);

    // Derive decryption key
    const key = await deriveKey(password);

    // Stream chunks incrementally
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Download and decrypt chunks in parallel batches
    (async () => {
        try {
            for (let i = 0; i < manifest.chunks.length; i += PARALLEL_DOWNLOADS) {
                const batch = manifest.chunks.slice(i, i + PARALLEL_DOWNLOADS);

                const chunkPromises = batch.map(chunk =>
                    downloadChunk(token, owner, chunk.shardRepo, chunk.blobSha)
                );

                const chunkBuffers = await Promise.all(chunkPromises);

                for (const chunkBuffer of chunkBuffers) {
                    // Decrypt chunk
                    const decrypted = await decryptData(chunkBuffer, key);

                    // Decompress
                    const decompressed = await decompressData(decrypted);

                    await writer.write(decompressed);
                }
            }

            await writer.close();
        } catch (error) {
            await writer.abort(error);
        }
    })();

    return new Response(readable, {
        headers: {
            ...CORS_HEADERS,
            'Content-Type': file.mimeType,
            'Content-Disposition': `attachment; filename="${file.name}"`,
        },
    });
}

// ============================================
// Health Check
// ============================================

function handleHealth() {
    return jsonResponse({
        status: 'ok',
        platform: 'cloudflare-workers',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
    });
}

// ============================================
// Utility Functions
// ============================================

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
        },
    });
}

function generateUUID() {
    return crypto.randomUUID();
}

function base64Encode(data) {
    const bytes = new Uint8Array(data);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64Decode(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

async function compressData(data) {
    const stream = new Response(data).body.pipeThrough(
        new CompressionStream('gzip')
    );
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

async function decompressData(data) {
    const stream = new Response(data).body.pipeThrough(
        new DecompressionStream('gzip')
    );
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}
