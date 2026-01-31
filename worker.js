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

// Default allowed origins (can be overridden via env.ALLOWED_ORIGINS)
const DEFAULT_ALLOWED_ORIGINS = [
    'https://ghost-ui.pages.dev',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
];

// ============================================
// CORS Helper
// ============================================

function getCorsHeaders(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = env.ALLOWED_ORIGINS
        ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
        : DEFAULT_ALLOWED_ORIGINS;

    // Check if origin is allowed
    const isAllowed = allowedOrigins.includes(origin) || allowedOrigins.includes('*');

    return {
        'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-ghost-token, x-ghost-pass',
        'Access-Control-Max-Age': '86400',
    };
}

// ============================================
// Main Worker Entry Point
// ============================================

export default {
    async fetch(request, env) {
        const corsHeaders = getCorsHeaders(request, env);

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // Route requests
            if (path === '/health' && request.method === 'GET') {
                return handleHealth(corsHeaders);
            }

            if (path === '/upload' && request.method === 'POST') {
                return await handleUpload(request, env, corsHeaders);
            }

            if (path.startsWith('/download/') && request.method === 'GET') {
                const fileId = path.split('/')[2];
                return await handleDownload(fileId, request, env, corsHeaders);
            }

            return jsonResponse({ error: 'Not found' }, corsHeaders, 404);
        } catch (error) {
            console.error('Worker error:', error);
            return jsonResponse({ error: error.message }, corsHeaders, 500);
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

// Encrypt chunk with its own IV
async function encryptChunk(data, key) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        data
    );

    // Return IV and encrypted data separately for manifest storage
    return {
        iv: Array.from(iv),
        ciphertext: new Uint8Array(encrypted),
    };
}

// Decrypt chunk with its specific IV
async function decryptChunk(ciphertext, iv, key) {
    const ivArray = new Uint8Array(iv);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ivArray },
        key,
        ciphertext
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
            return { data: { files: [], shardSizes: {} }, sha: null };
        }
        throw new Error(`Failed to fetch index: ${response.statusText}`);
    }

    const json = await response.json();
    const content = base64Decode(json.content.replace(/\n/g, ''));

    // Decrypt index (uses single IV for index file only)
    const key = await deriveKey(password);
    const iv = content.slice(0, IV_LENGTH);
    const ciphertext = content.slice(IV_LENGTH);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
    );

    const data = JSON.parse(new TextDecoder().decode(decrypted));

    // Ensure shardSizes exists
    if (!data.shardSizes) {
        data.shardSizes = {};
    }

    return { data, sha: json.sha };
}

async function updateIndex(token, owner, repo, password, data, sha) {
    const key = await deriveKey(password);
    const jsonStr = JSON.stringify(data);

    // Encrypt index with its own IV
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(jsonStr)
    );

    // Prepend IV to encrypted data
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    const content = base64Encode(result);

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
            retries++;
            const fresh = await fetchIndex(token, owner, repo, password);

            // Merge strategy
            const merged = {
                files: [...fresh.data.files, ...data.files.filter(
                    f => !fresh.data.files.find(existing => existing.id === f.id)
                )],
                shardSizes: { ...fresh.data.shardSizes, ...data.shardSizes },
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

async function selectShard(token, owner, shardSizes, chunkSize) {
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
    const shards = repos.filter(r => r.name.startsWith('ghost-drive-shard-'))
        .sort((a, b) => a.name.localeCompare(b.name));

    // Find shard with available space
    for (const shard of shards) {
        const currentSize = shardSizes[shard.name] || 0;
        if (currentSize + chunkSize < SHARD_SIZE_LIMIT) {
            return shard.name;
        }
    }

    // All shards full or no shards exist - create new one
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

    // Initialize size tracking for new shard
    shardSizes[shardName] = 0;

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
// Upload Handler (Streaming)
// ============================================

async function handleUpload(request, env, corsHeaders) {
    const token = request.headers.get('x-ghost-token') || getRotatedToken(env);
    const password = request.headers.get('x-ghost-pass');

    if (!password) {
        return jsonResponse({ error: 'Missing x-ghost-pass header' }, corsHeaders, 400);
    }

    const owner = env.GITHUB_OWNER || 'ghostdriveg1';
    const indexRepo = env.GITHUB_INDEX_REPO || 'ghost-drive-index';

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
        return jsonResponse({ error: 'No file provided' }, corsHeaders, 400);
    }

    const fileId = generateUUID();
    const fileName = file.name;
    const fileSize = file.size;
    const mimeType = file.type;

    // Derive encryption key
    const key = await deriveKey(password);

    // Fetch current index for shard tracking
    const { data: indexData, sha: indexSha } = await fetchIndex(token, owner, indexRepo, password);
    const shardSizes = indexData.shardSizes || {};

    // Stream file: chunk raw data -> compress each chunk -> encrypt each chunk -> upload
    const chunks = [];
    const stream = file.stream();
    const reader = stream.getReader();

    let buffer = new Uint8Array(0);
    let chunkIndex = 0;
    let done = false;

    while (!done) {
        const { value, done: streamDone } = await reader.read();
        done = streamDone;

        if (value) {
            // Append to buffer
            const newBuffer = new Uint8Array(buffer.length + value.length);
            newBuffer.set(buffer);
            newBuffer.set(value, buffer.length);
            buffer = newBuffer;
        }

        // Process chunks when buffer is large enough or stream is done
        while (buffer.length >= CHUNK_SIZE || (done && buffer.length > 0)) {
            const chunkSize = Math.min(CHUNK_SIZE, buffer.length);
            const chunkData = buffer.slice(0, chunkSize);
            buffer = buffer.slice(chunkSize);

            // Compress this chunk independently
            const compressed = await compressData(chunkData);

            // Encrypt with its own IV
            const { iv, ciphertext } = await encryptChunk(compressed, key);

            // Select shard based on current sizes
            const shard = await selectShard(token, owner, shardSizes, ciphertext.length);
            const chunkPath = `chunks/${fileId}/${chunkIndex}.enc`;

            // Upload chunk
            const blobSha = await uploadChunk(token, owner, shard, chunkPath, ciphertext);

            // Track shard size
            shardSizes[shard] = (shardSizes[shard] || 0) + ciphertext.length;

            // Store chunk metadata with IV
            chunks.push({
                id: `${fileId}-${chunkIndex}`,
                position: chunkIndex,
                size: ciphertext.length,
                blobSha,
                shardRepo: shard,
                iv, // Store IV for this specific chunk
            });

            chunkIndex++;

            if (buffer.length < CHUNK_SIZE) break;
        }
    }

    // Write manifest
    const manifest = {
        fileId,
        chunks,
    };
    await writeManifest(token, owner, indexRepo, fileId, manifest);

    // Update index
    indexData.files.push({
        id: fileId,
        name: fileName,
        path: `/${fileName}`,
        size: fileSize,
        mimeType,
        uploadedAt: new Date().toISOString(),
        manifest: JSON.stringify(manifest),
    });

    indexData.shardSizes = shardSizes;

    await updateIndex(token, owner, indexRepo, password, indexData, indexSha);

    return jsonResponse({
        success: true,
        fileId,
        size: fileSize,
    }, corsHeaders);
}

// ============================================
// Download Handler (Streaming)
// ============================================

async function handleDownload(fileId, request, env, corsHeaders) {
    const token = request.headers.get('x-ghost-token') || getRotatedToken(env);
    const password = request.headers.get('x-ghost-pass');

    if (!password) {
        return jsonResponse({ error: 'Missing x-ghost-pass header' }, corsHeaders, 400);
    }

    const owner = env.GITHUB_OWNER || 'ghostdriveg1';
    const indexRepo = env.GITHUB_INDEX_REPO || 'ghost-drive-index';

    // Fetch index
    const { data } = await fetchIndex(token, owner, indexRepo, password);
    const file = data.files.find(f => f.id === fileId);

    if (!file) {
        return jsonResponse({ error: 'File not found' }, corsHeaders, 404);
    }

    // Load manifest
    const manifest = await loadManifest(token, owner, indexRepo, fileId);

    // Derive decryption key
    const key = await deriveKey(password);

    // Stream chunks: download -> decrypt with chunk IV -> decompress -> output
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    (async () => {
        try {
            for (let i = 0; i < manifest.chunks.length; i += PARALLEL_DOWNLOADS) {
                const batch = manifest.chunks.slice(i, i + PARALLEL_DOWNLOADS);

                const chunkPromises = batch.map(chunk =>
                    downloadChunk(token, owner, chunk.shardRepo, chunk.blobSha)
                );

                const chunkBuffers = await Promise.all(chunkPromises);

                // Process each chunk in order with its specific IV
                for (let j = 0; j < chunkBuffers.length; j++) {
                    const chunkBuffer = chunkBuffers[j];
                    const chunkMeta = batch[j];

                    // Decrypt with this chunk's IV
                    const decrypted = await decryptChunk(chunkBuffer, chunkMeta.iv, key);

                    // Decompress this chunk
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
            ...corsHeaders,
            'Content-Type': file.mimeType,
            'Content-Disposition': `attachment; filename="${file.name}"`,
        },
    });
}

// ============================================
// Health Check
// ============================================

function handleHealth(corsHeaders) {
    return jsonResponse({
        status: 'ok',
        platform: 'cloudflare-workers',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
    }, corsHeaders);
}

// ============================================
// Utility Functions
// ============================================

function jsonResponse(data, corsHeaders, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...corsHeaders,
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
