# Ghost Engine

**Cloud compute layer for Ghost Drive**

The serverless compute engine that handles all file processing operations for Ghost Drive. Deployed on GitHub Codespaces for zero-cost operation.

## ✨ Features

- **Streaming Encryption/Decryption** - Process files without loading entire content into RAM
- **GitHub API Orchestration** - Manages file sharding across GitHub repositories
- **Stateless Architecture** - No database required, all state derived from GitHub
- **Fleet Protocol Support** - Auto-discovery and load balancing across multiple engines

## 🚀 Quick Start

### Prerequisites

- GitHub account (free)

### Deployment on GitHub Codespaces

1. **Navigate to your `ghost-engine` repository on GitHub**

2. **Create a Codespace**
   - Click the **Code** button (green)
   - Select the **Codespaces** tab
   - Click **Create codespace on main**

3. **Wait for initialization** (2-3 minutes)
   - Dependencies will install automatically
   - TypeScript will compile automatically
   - Server will start automatically on port 3001

4. **Copy your Codespace URL**
   - Format: `https://expert-guacamole-5000.app.github.dev`
   - This is your Engine URL for Ghost Drive configuration

5. **Verify it's running**
   - Visit `https://your-codespace-url/health`
   - You should see: `{"status":"ok","timestamp":"...","version":"1.0.0"}`

## ⚙️ Configuration

### Environment Variables

Create a `.env` file (copy from `.env.example`):

```env
PORT=3001
NODE_ENV=production
```

**Note:** GitHub tokens and encryption passwords are NOT stored in environment variables. They're passed via HTTP headers from the client (zero-knowledge architecture).

## 🛠️ Development

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm run dev
```

Server will start on [http://localhost:3001](http://localhost:3001)

### Build for production

```bash
npm run build
```

### Start production server

```bash
npm start
```

## 📡 API Endpoints

### Production Endpoints

#### Health Check
```
GET /health
Response: {
  "status": "ok",
  "timestamp": "2026-01-28T...",
  "version": "1.0.0"
}
```

#### Upload File
```
POST /upload
Headers:
  - x-ghost-token: GitHub Personal Access Token
  - x-ghost-pass: Encryption password
Body: multipart/form-data with file
Response: File metadata with upload confirmation
```

#### Download File
```
GET /download/:fileId
Headers:
  - x-ghost-token: GitHub Personal Access Token
  - x-ghost-pass: Encryption password
Response: Streaming file download
```

### Integration Test Endpoints

These endpoints are available for testing core functionality:

#### Fetch Encrypted Index
```
GET /test/fetch-index
Headers:
  - x-ghost-token: GitHub Personal Access Token
  - x-ghost-pass: Encryption password
Response: Encrypted index data with SHA
```

#### Update Index with Optimistic Locking
```
POST /test/update-index
Headers:
  - x-ghost-token: GitHub Personal Access Token
  - x-ghost-pass: Encryption password
Body: { "fileName": "test.txt", "fileSize": 1024 }
Response: Success confirmation with file count
```

#### Upload Test Chunks
```
POST /test/upload-chunks
Headers:
  - x-ghost-token: GitHub Personal Access Token
Body: { "shardRepo": "ghost-drive-shard-001", "chunkCount": 3 }
Response: Batch upload confirmation
```

**Note:** Additional production endpoints (index, thumbnail, delete, shard) are planned but not yet implemented.

## 📦 Tech Stack

- **[Express](https://expressjs.com/)** - Fast, unopinionated web framework
- **[Octokit](https://github.com/octokit/octokit.js)** - Official GitHub REST API client
- **[simple-git](https://github.com/steveukx/git-js)** - Git command wrapper
- **[Node.js crypto](https://nodejs.org/api/crypto.html)** - Built-in encryption/decryption
- **[zlib](https://nodejs.org/api/zlib.html)** - Built-in compression/decompression
- **TypeScript** - Type-safe development

## 🔧 Auto-Start Behavior

When deploying to GitHub Codespaces, the devcontainer configuration:

1. **On Creation**: Runs `npm install && npm run build`
   - Installs all dependencies
   - Compiles TypeScript to JavaScript in `dist/` directory

2. **On Start**: Runs `npm start`
   - Starts the Express server on port 3001
   - Requires `dist/index.js` to exist (created by build step)

3. **Port Forwarding**: Automatically forwards port 3001 with notifications

## 📄 License

MIT License - see [LICENSE](LICENSE) for details