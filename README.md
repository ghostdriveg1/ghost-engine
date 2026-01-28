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
   - Server will start automatically on port 3001

4. **Copy your Codespace URL**
   - Format: `https://expert-guacamole-5000.app.github.dev`
   - This is your Engine URL for Ghost Drive configuration

5. **Verify it's running**
   - Visit `https://your-codespace-url/health`
   - You should see: `{"status":"ok","timestamp":"..."}`

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

### Health Check
```
GET /health
Response: { "status": "ok", "timestamp": "..." }
```

### Upload File
```
POST /upload
Headers:
  - x-ghost-token: GitHub Personal Access Token
  - x-ghost-pass: Encryption password
Body: multipart/form-data with file
```

### Download File
```
GET /download/:fileId
Headers:
  - x-ghost-token: GitHub Personal Access Token
  - x-ghost-pass: Encryption password
Response: Streaming file download
```

### Get File Index
```
GET /index
Headers:
  - x-ghost-token: GitHub Personal Access Token
Response: Array of file metadata
```

### Get Thumbnail
```
GET /thumbnail/:fileId
Headers:
  - x-ghost-token: GitHub Personal Access Token
  - x-ghost-pass: Encryption password
Response: Image thumbnail
```

### Delete File
```
DELETE /delete/:fileId
Headers:
  - x-ghost-token: GitHub Personal Access Token
Response: { "success": true }
```

### Create Shard
```
POST /shard/create
Headers:
  - x-ghost-token: GitHub Personal Access Token
Body: Shard data
Response: { "success": true, "shardId": "..." }
```

## 📦 Tech Stack

- **[Express](https://expressjs.com/)** - Fast, unopinionated web framework
- **[Octokit](https://github.com/octokit/octokit.js)** - Official GitHub REST API client
- **[simple-git](https://github.com/steveukx/git-js)** - Git command wrapper
- **[Node.js crypto](https://nodejs.org/api/crypto.html)** - Built-in encryption/decryption
- **[zlib](https://nodejs.org/api/zlib.html)** - Built-in compression/decompression
- **TypeScript** - Type-safe development

## 📄 License

MIT License - see [LICENSE](LICENSE) for details