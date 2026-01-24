# Politician MCP Server

A local AI agent that stores and converts concepts between three representations: **vectors**, **markdown**, and **ThoughtForm** (structured JSON). Built as a Model Context Protocol (MCP) server for seamless integration with Claude Desktop and other MCP-compatible clients.

---

## Key Features

- **Multi-Representation Storage**: Store concepts as 768-dimensional vectors, human-readable markdown, or structured ThoughtForm JSON
- **Bidirectional Conversion**: Convert between any two representations with 6 conversion commands
- **Semantic Search**: Find similar concepts using FAISS-powered vector similarity search
- **Named Entity Recognition**: Automatic entity extraction using spaCy NER
- **Local-First**: All processing happens locally - no external API calls required
- **MCP Native**: Full integration with Anthropic's Model Context Protocol

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    MCP Server (TypeScript)                      │
│                  @modelcontextprotocol/sdk                      │
├─────────────────────────────────────────────────────────────────┤
│  17 Tools: save/read/convert concepts + utilities               │
├─────────────────────────────────────────────────────────────────┤
│  Storage: Drizzle ORM + better-sqlite3 (WAL mode)               │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP (localhost:8787)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Python Sidecar (FastAPI)                     │
├─────────────────────────────────────────────────────────────────┤
│  • sentence-transformers (all-MiniLM-L6-v2) - 768-dim embeddings│
│  • spaCy (en_core_web_sm) - Named Entity Recognition            │
│  • FAISS - Vector similarity search                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

- [Quick Start](#quick-start)
- [Requirements](#requirements)
- [Installation](#installation)
- [Build Guide](#build-guide)
- [Configuration](#configuration)
- [Deployment](#deployment)
  - [Local Development](#local-development)
  - [Claude Desktop Integration](#claude-desktop-integration)
  - [Docker Deployment](#docker-deployment)
  - [systemd Service](#systemd-service-linux)
  - [PM2 Process Manager](#pm2-process-manager)
  - [Cloud Deployment](#cloud-deployment)
- [Usage Manual](#usage-manual)
  - [Core Concepts](#core-concepts)
  - [Tutorial 1: Store Your First Concept](#tutorial-1-store-your-first-concept)
  - [Tutorial 2: Convert Between Formats](#tutorial-2-convert-between-formats)
  - [Tutorial 3: Semantic Search](#tutorial-3-semantic-search-with-vectors)
  - [Tutorial 4: Knowledge Graph](#tutorial-4-building-a-knowledge-graph)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Quick Start

Get up and running in 2 minutes:

```bash
# Clone and install Node.js dependencies
git clone https://github.com/yourusername/politician.git
cd politician
npm install

# Set up Python environment
cd python-sidecar
python3 -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python -m spacy download en_core_web_sm
cd ..

# Build and run
npm run build
npm start
```

The server will start on stdio, ready for MCP client connections.

---

## Requirements

### System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **OS** | macOS 12+, Ubuntu 20.04+, Windows 10+ (WSL2) | macOS 14+, Ubuntu 22.04+ |
| **RAM** | 4 GB | 8 GB+ |
| **Disk** | 2 GB free | 5 GB+ free |
| **CPU** | 2 cores | 4+ cores |

### Software Requirements

| Software | Version | Purpose |
|----------|---------|---------|
| **Node.js** | >= 20.0.0 | MCP server runtime |
| **Python** | >= 3.10 | ML sidecar service |
| **npm** | >= 10.0.0 | Package management |
| **pip** | >= 23.0 | Python package management |

### Verify Requirements

```bash
# Check Node.js version
node --version  # Should be v20.x.x or higher

# Check Python version
python3 --version  # Should be 3.10.x or higher

# Check npm version
npm --version  # Should be 10.x.x or higher
```

---

## Installation

### Step 1: Clone the Repository

```bash
git clone https://github.com/yourusername/politician.git
cd politician
```

### Step 2: Install Node.js Dependencies

```bash
npm install
```

This installs:
- `@modelcontextprotocol/sdk` - MCP server framework
- `better-sqlite3` - SQLite database driver
- `drizzle-orm` - Type-safe ORM
- `zod` - Schema validation
- `uuid` - UUID generation

### Step 3: Set Up Python Environment

Create and activate a virtual environment:

```bash
cd python-sidecar

# Create virtual environment
python3 -m venv venv

# Activate it
# macOS/Linux:
source venv/bin/activate
# Windows (PowerShell):
.\venv\Scripts\Activate.ps1
# Windows (CMD):
venv\Scripts\activate.bat
```

### Step 4: Install Python Dependencies

```bash
pip install -r requirements.txt
```

This installs:
- `fastapi` + `uvicorn` - HTTP server
- `sentence-transformers` - Text embeddings (~400 MB model download)
- `spacy` - NER pipeline
- `faiss-cpu` - Vector similarity search
- `numpy` - Numerical operations

### Step 5: Download spaCy Model

```bash
python -m spacy download en_core_web_sm
```

This downloads the English NER model (~12 MB).

### Step 6: Return to Project Root

```bash
cd ..
```

### Step 7: Verify Installation

```bash
# Type-check TypeScript
npm run typecheck

# Build the project
npm run build

# Verify Python sidecar can start
cd python-sidecar
python -c "from embeddings import get_model; print('Embeddings OK')"
python -c "from ner import get_nlp; print('NER OK')"
cd ..
```

If all commands succeed, the installation is complete.

---

## Build Guide

### Development Mode

Run with hot-reload using `tsx`:

```bash
npm run dev
```

This:
- Runs TypeScript directly without compilation
- Automatically restarts on file changes
- Provides better error messages with source maps

### Production Build

Compile TypeScript to JavaScript:

```bash
npm run build
```

Output is written to the `dist/` directory.

Run the production build:

```bash
npm start
```

### Type Checking

Verify types without building:

```bash
npm run typecheck
```

### Database Migrations

If you modify `src/db/schema.ts`, generate migrations:

```bash
npm run db:generate  # Generate migration files
npm run db:push      # Apply changes directly (dev only)
npm run db:studio    # Open Drizzle Studio GUI
```

### Build Artifacts

After building, you'll have:

```
dist/
├── index.js          # Entry point
├── server.js         # MCP server setup
├── db/
│   ├── schema.js     # Database schema
│   └── client.js     # Database connection
├── types/
│   ├── concept.js    # Concept types
│   └── thoughtform.js # ThoughtForm types
├── services/
│   ├── python-bridge.js    # Python HTTP client
│   ├── concept.service.js  # CRUD operations
│   └── conversion.service.js # Conversions
└── commands/
    ├── save.js       # Save handlers
    ├── read.js       # Read handlers
    └── convert.js    # Convert handlers
```

---

## Configuration

### Environment Variables

Create a `.env` file in the project root (copy from `.env.example`):

```bash
cp .env.example .env
```

| Variable | Default | Description |
|----------|---------|-------------|
| `SIDECAR_HOST` | `127.0.0.1` | Python sidecar bind address |
| `SIDECAR_PORT` | `8787` | Python sidecar port |
| `DB_PATH` | `./data/concepts.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Logging level (debug, info, warn, error) |
| `EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | Sentence transformer model |
| `SPACY_MODEL` | `en_core_web_sm` | spaCy NER model |

### Database Settings

The SQLite database is created automatically at `./data/concepts.db` with:

- **WAL mode** enabled for better concurrency
- **Foreign keys** enabled for referential integrity
- Automatic indexes on `created_at` and `updated_at`

To use a different location:

```bash
export DB_PATH=/path/to/your/database.db
```

### Python Sidecar Settings

The Python sidecar runs on `localhost:8787` by default. To change:

1. Set `SIDECAR_PORT` environment variable
2. Update `python-sidecar/main.py` if running standalone

### Model Configuration

**Embedding Model** (sentence-transformers):
- Default: `all-MiniLM-L6-v2` (768 dimensions, ~80 MB)
- Alternative: `all-mpnet-base-v2` (768 dimensions, ~420 MB, higher quality)

**NER Model** (spaCy):
- Default: `en_core_web_sm` (12 MB, fast)
- Alternative: `en_core_web_md` (40 MB, better accuracy)
- Alternative: `en_core_web_lg` (560 MB, best accuracy)

To change models, update `python-sidecar/embeddings.py` and `python-sidecar/ner.py`.

---

## Deployment

### Local Development

The simplest way to run for development:

```bash
# Terminal 1: Run the MCP server
npm run dev
```

The Python sidecar is automatically spawned by the TypeScript server.

### Claude Desktop Integration

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "politician": {
      "command": "node",
      "args": ["/absolute/path/to/politician/dist/index.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

**Important**: Use the absolute path to `dist/index.js`.

After saving, restart Claude Desktop. You should see "politician" in the MCP servers list.

### Docker Deployment

#### Using Docker Compose (Recommended)

```bash
# Build and start
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

#### Using Docker Directly

```bash
# Build the image
docker build -t politician:latest .

# Run the container
docker run -d \
  --name politician \
  -v politician-data:/app/data \
  -p 8787:8787 \
  politician:latest

# View logs
docker logs -f politician

# Stop
docker stop politician && docker rm politician
```

#### Docker with Claude Desktop

For Claude Desktop integration with Docker, use a wrapper script:

```bash
#!/bin/bash
# save as: /usr/local/bin/politician-mcp
docker exec -i politician node /app/dist/index.js
```

Then in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "politician": {
      "command": "/usr/local/bin/politician-mcp"
    }
  }
}
```

### systemd Service (Linux)

Create a service file at `/etc/systemd/system/politician.service`:

```ini
[Unit]
Description=Politician MCP Server
After=network.target

[Service]
Type=simple
User=politician
Group=politician
WorkingDirectory=/opt/politician
Environment=NODE_ENV=production
Environment=PATH=/opt/politician/python-sidecar/venv/bin:/usr/bin
ExecStart=/usr/bin/node /opt/politician/dist/index.js
Restart=always
RestartSec=10

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=politician

# Security
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/politician/data

[Install]
WantedBy=multi-user.target
```

Install and start:

```bash
# Create service user
sudo useradd -r -s /bin/false politician

# Copy files
sudo cp -r . /opt/politician
sudo chown -R politician:politician /opt/politician

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable politician
sudo systemctl start politician

# Check status
sudo systemctl status politician
sudo journalctl -u politician -f
```

### PM2 Process Manager

Create `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [{
    name: 'politician',
    script: 'dist/index.js',
    cwd: '/path/to/politician',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      SIDECAR_PORT: 8787
    },
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    log_file: 'logs/combined.log',
    time: true
  }]
};
```

Start with PM2:

```bash
# Install PM2 globally
npm install -g pm2

# Start the application
pm2 start ecosystem.config.js

# Save process list
pm2 save

# Enable startup script
pm2 startup

# View logs
pm2 logs politician

# Monitor
pm2 monit
```

### Cloud Deployment

#### AWS EC2 / GCP Compute Engine

1. Launch an instance (t3.medium / e2-medium minimum)
2. Install Node.js 20+ and Python 3.10+
3. Clone the repository
4. Follow the [Installation](#installation) steps
5. Set up systemd or PM2 for process management
6. Configure security groups to block port 8787 from external access

#### Docker on Cloud

For AWS ECS, GCP Cloud Run, or Azure Container Instances:

1. Push image to container registry:
   ```bash
   docker tag politician:latest gcr.io/your-project/politician:latest
   docker push gcr.io/your-project/politician:latest
   ```

2. Deploy with persistent volume for `/app/data`

3. Ensure the container has at least 2 GB RAM for ML models

#### Important Security Notes

- The Python sidecar should **never** be exposed to the public internet
- Always bind to `127.0.0.1` (localhost) only
- Use a reverse proxy (nginx, Caddy) if external access is needed
- The MCP server communicates via stdio, not network ports

---

## Usage Manual

### Core Concepts

#### The Three Representations

Politician stores concepts in three interchangeable formats:

| Representation | Type | Best For |
|----------------|------|----------|
| **Vector** | `float[768]` | Semantic search, similarity matching |
| **Markdown** | `string` | Human-readable display, documentation |
| **ThoughtForm** | `JSON object` | Structured data, entity relationships |

#### ThoughtForm Structure

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "rawText": "Original text content",
  "language": "en",
  "metadata": {
    "timestamp": "2024-01-15T10:30:00Z",
    "author": "user",
    "tags": ["example", "demo"],
    "source": "user_input"
  },
  "entities": [
    {
      "id": "ent_0",
      "text": "John Smith",
      "type": "PERSON",
      "confidence": 1.0,
      "offset": {"start": 0, "end": 10}
    }
  ],
  "relationships": [
    {
      "subjectId": "ent_0",
      "predicate": "works_at",
      "objectId": "ent_1"
    }
  ],
  "contextGraph": {
    "ent_0": ["ent_1"],
    "ent_1": ["ent_0"]
  },
  "embeddings": [0.123, -0.456, ...]
}
```

#### Conversion Matrix

```
                    ┌─────────────┐
                    │ ThoughtForm │
                    └──────┬──────┘
                  ┌────────┼────────┐
                  │        │        │
                  ▼        │        ▼
           ┌──────────┐    │   ┌──────────┐
           │  Vector  │◄───┴───│ Markdown │
           └──────────┘        └──────────┘
```

All 6 conversions are supported:
- `thoughtForm → vector`: Embed raw_text
- `thoughtForm → markdown`: Format as readable text
- `vector → thoughtForm`: Find similar concepts, reconstruct
- `vector → markdown`: Find similar concepts, summarize
- `markdown → vector`: Embed markdown text
- `markdown → thoughtForm`: Extract entities via NER

---

### Tutorial 1: Store Your First Concept

Let's store a simple concept and explore its representations.

#### Step 1: Generate a Concept ID

Call the `generate_id` tool:

```json
// Request
{}

// Response
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

#### Step 2: Save as ThoughtForm

Call `save_concept_as_thoughtForm`:

```json
// Request
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "thoughtForm": {
    "rawText": "Albert Einstein developed the theory of relativity while working at the Swiss Patent Office in Bern. His famous equation E=mc² revolutionized physics.",
    "language": "en"
  },
  "tags": ["physics", "history", "science"]
}

// Response
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

#### Step 3: Read It Back

Call `read_concept_from_thoughtForm`:

```json
// Request
{
  "id": "550e8400-e29b-41d4-a716-446655440000"
}

// Response
{
  "success": true,
  "data": {
    "thoughtForm": {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "rawText": "Albert Einstein developed the theory of relativity...",
      "language": "en",
      "metadata": {
        "timestamp": "2024-01-15T10:30:00Z",
        "author": null,
        "tags": ["physics", "history", "science"],
        "source": "user_input"
      },
      "entities": [],
      "relationships": [],
      "contextGraph": {}
    }
  }
}
```

#### Step 4: Check Available Representations

Call `get_representations`:

```json
// Request
{
  "id": "550e8400-e29b-41d4-a716-446655440000"
}

// Response
{
  "success": true,
  "data": {
    "vectors": false,
    "md": false,
    "thoughtForm": true
  }
}
```

Only ThoughtForm is stored so far. Let's convert to other formats!

---

### Tutorial 2: Convert Between Formats

Starting from the concept created in Tutorial 1, let's generate all representations.

#### Step 1: Convert ThoughtForm to Vector

Call `convert_concept_from_thoughtForm_to_vectors`:

```json
// Request
{
  "id": "550e8400-e29b-41d4-a716-446655440000"
}

// Response
{
  "success": true,
  "data": {
    "vector": [0.0234, -0.0891, 0.0456, ...]  // 768 floats
  }
}
```

This:
1. Reads the ThoughtForm's `rawText`
2. Sends it to the Python sidecar for embedding
3. Stores the vector in the database
4. Updates the FAISS index for similarity search

#### Step 2: Convert ThoughtForm to Markdown

Call `convert_concept_from_thoughtForm_to_md`:

```json
// Request
{
  "id": "550e8400-e29b-41d4-a716-446655440000"
}

// Response
{
  "success": true,
  "data": {
    "md": "# Albert Einstein developed the...\n\n## Metadata\n\n- **Language:** en\n- **Created:** 2024-01-15T10:30:00Z\n- **Tags:** physics, history, science\n\n## Content\n\nAlbert Einstein developed the theory of relativity..."
  }
}
```

#### Step 3: Verify All Representations

Call `get_representations`:

```json
// Response
{
  "success": true,
  "data": {
    "vectors": true,
    "md": true,
    "thoughtForm": true
  }
}
```

Now all three formats are stored!

#### Step 4: Read Each Format

You can read any representation:

```json
// read_concept_from_vectors
{"id": "550e8400-..."}
// Returns: {"vector": [0.0234, ...]}

// read_concept_from_md
{"id": "550e8400-..."}
// Returns: {"md": "# Albert Einstein..."}

// read_concept_from_thoughtForm
{"id": "550e8400-..."}
// Returns: {"thoughtForm": {...}}
```

---

### Tutorial 3: Semantic Search with Vectors

Let's explore how vector similarity search works.

#### Step 1: Store Multiple Related Concepts

Store several physics-related concepts:

```json
// Concept 1: Einstein
{
  "id": "aaaa-...",
  "thoughtForm": {"rawText": "Albert Einstein developed the theory of relativity..."}
}

// Concept 2: Newton
{
  "id": "bbbb-...",
  "thoughtForm": {"rawText": "Isaac Newton formulated the laws of motion and universal gravitation..."}
}

// Concept 3: Curie
{
  "id": "cccc-...",
  "thoughtForm": {"rawText": "Marie Curie pioneered research on radioactivity and won two Nobel Prizes..."}
}

// Concept 4: Shakespeare (unrelated)
{
  "id": "dddd-...",
  "thoughtForm": {"rawText": "William Shakespeare wrote plays like Hamlet and Romeo and Juliet..."}
}
```

#### Step 2: Convert All to Vectors

For each concept, call `convert_concept_from_thoughtForm_to_vectors`.

#### Step 3: Store a Query Vector Only

Create a new concept with just a vector (no text):

```json
// save_concept_as_vectors
{
  "id": "query-...",
  "vector": [/* 768 floats representing "famous physicists" */]
}
```

#### Step 4: Convert Vector to Markdown

Call `convert_concept_from_vectors_to_md`:

```json
// Request
{
  "id": "query-..."
}

// Response
{
  "success": true,
  "data": {
    "md": "## Summary\n\nBased on 3 related concepts:\n\n- Concept `aaaa-...`\n- Concept `bbbb-...`\n- Concept `cccc-...`\n\n..."
  }
}
```

The system found Einstein, Newton, and Curie as the most similar concepts (Shakespeare was excluded as unrelated).

---

### Tutorial 4: Building a Knowledge Graph

Extract entities and relationships to build a knowledge graph.

#### Step 1: Store a Rich Text Concept

```json
// save_concept_as_thoughtForm
{
  "id": "graph-1",
  "thoughtForm": {
    "rawText": "Elon Musk founded SpaceX in 2002 and Tesla in 2003. SpaceX is headquartered in Hawthorne, California. Tesla's main factory is in Fremont, California."
  }
}
```

#### Step 2: Convert Markdown to ThoughtForm (NER Extraction)

First, save as markdown, then convert to extract entities:

```json
// save_concept_as_md
{
  "id": "graph-2",
  "md": "Apple Inc. was founded by Steve Jobs and Steve Wozniak in Cupertino. Tim Cook is the current CEO."
}

// convert_concept_from_md_to_thoughtForm
{
  "id": "graph-2"
}

// Response
{
  "success": true,
  "data": {
    "thoughtForm": {
      "id": "graph-2",
      "rawText": "Apple Inc. was founded by Steve Jobs...",
      "entities": [
        {"id": "ent_0", "text": "Apple Inc.", "type": "ORG", "confidence": 1.0, ...},
        {"id": "ent_1", "text": "Steve Jobs", "type": "PERSON", "confidence": 1.0, ...},
        {"id": "ent_2", "text": "Steve Wozniak", "type": "PERSON", "confidence": 1.0, ...},
        {"id": "ent_3", "text": "Cupertino", "type": "GPE", "confidence": 1.0, ...},
        {"id": "ent_4", "text": "Tim Cook", "type": "PERSON", "confidence": 1.0, ...}
      ],
      "relationships": [
        {"subjectId": "ent_1", "predicate": "founded", "objectId": "ent_0"},
        {"subjectId": "ent_2", "predicate": "founded", "objectId": "ent_0"}
      ],
      "contextGraph": {
        "ent_0": ["ent_1", "ent_2", "ent_3", "ent_4"],
        "ent_1": ["ent_0"],
        "ent_2": ["ent_0"],
        "ent_3": ["ent_0"],
        "ent_4": ["ent_0"]
      }
    }
  }
}
```

#### Step 3: Query the Graph

The `contextGraph` is an adjacency list. You can:
- Find all entities connected to "Apple Inc." (`ent_0`)
- Trace relationships between people and organizations
- Build visualizations using the graph structure

---

## API Reference

### Save Commands

#### `save_concept_as_vectors`

Save a 768-dimensional vector representation.

**Input:**
```json
{
  "id": "string (UUID, required)",
  "vector": "number[] (768 floats, required)",
  "tags": "string[] (optional)"
}
```

**Output:**
```json
{
  "success": true,
  "data": {"id": "..."}
}
```

---

#### `save_concept_as_md`

Save a markdown representation.

**Input:**
```json
{
  "id": "string (UUID, required)",
  "md": "string (non-empty, required)",
  "tags": "string[] (optional)"
}
```

**Output:**
```json
{
  "success": true,
  "data": {"id": "..."}
}
```

---

#### `save_concept_as_thoughtForm`

Save a ThoughtForm (structured JSON) representation.

**Input:**
```json
{
  "id": "string (UUID, required)",
  "thoughtForm": {
    "rawText": "string (required)",
    "language": "string (default: 'en')",
    "metadata": {
      "timestamp": "ISO 8601 datetime",
      "author": "string | null",
      "tags": "string[]",
      "source": "string"
    },
    "entities": "Entity[]",
    "relationships": "Relationship[]",
    "contextGraph": "Record<string, string[]>",
    "embeddings": "number[]"
  },
  "tags": "string[] (optional)"
}
```

**Output:**
```json
{
  "success": true,
  "data": {"id": "..."}
}
```

---

### Read Commands

#### `read_concept_from_vectors`

Read the vector representation.

**Input:**
```json
{
  "id": "string (UUID, required)"
}
```

**Output:**
```json
{
  "success": true,
  "data": {
    "vector": [0.123, -0.456, ...]
  }
}
```

---

#### `read_concept_from_md`

Read the markdown representation.

**Input:**
```json
{
  "id": "string (UUID, required)"
}
```

**Output:**
```json
{
  "success": true,
  "data": {
    "md": "# Title\n\nContent..."
  }
}
```

---

#### `read_concept_from_thoughtForm`

Read the ThoughtForm representation.

**Input:**
```json
{
  "id": "string (UUID, required)"
}
```

**Output:**
```json
{
  "success": true,
  "data": {
    "thoughtForm": {
      "id": "...",
      "rawText": "...",
      "entities": [...],
      ...
    }
  }
}
```

---

### Convert Commands

#### `convert_concept_from_thoughtForm_to_vectors`

Embed ThoughtForm's raw_text into a 768-dim vector.

**Input:** `{"id": "UUID"}`
**Output:** `{"vector": [...]}`

---

#### `convert_concept_from_thoughtForm_to_md`

Format ThoughtForm as human-readable markdown.

**Input:** `{"id": "UUID"}`
**Output:** `{"md": "..."}`

---

#### `convert_concept_from_vectors_to_thoughtForm`

Find similar concepts via FAISS and reconstruct a ThoughtForm.

**Input:** `{"id": "UUID"}`
**Output:** `{"thoughtForm": {...}}`

---

#### `convert_concept_from_vectors_to_md`

Find similar concepts and generate a summary.

**Input:** `{"id": "UUID"}`
**Output:** `{"md": "..."}`

---

#### `convert_concept_from_md_to_vectors`

Embed markdown text into a 768-dim vector.

**Input:** `{"id": "UUID"}`
**Output:** `{"vector": [...]}`

---

#### `convert_concept_from_md_to_thoughtForm`

Parse markdown and extract entities via NER.

**Input:** `{"id": "UUID"}`
**Output:** `{"thoughtForm": {...}}`

---

### Utility Commands

#### `list_concepts`

List all stored concepts with their available representations.

**Input:** `{}`

**Output:**
```json
{
  "success": true,
  "data": {
    "concepts": [
      {
        "id": "...",
        "createdAt": "2024-01-15T10:30:00Z",
        "updatedAt": "2024-01-15T10:30:00Z",
        "tags": ["..."],
        "representations": {
          "vectors": true,
          "md": false,
          "thoughtForm": true
        }
      }
    ],
    "count": 1
  }
}
```

---

#### `get_representations`

Check which representations exist for a concept.

**Input:** `{"id": "UUID"}`

**Output:**
```json
{
  "success": true,
  "data": {
    "vectors": true,
    "md": false,
    "thoughtForm": true
  }
}
```

---

#### `delete_concept`

Delete a concept and all its representations.

**Input:** `{"id": "UUID"}`

**Output:**
```json
{
  "success": true,
  "data": {"deleted": "..."}
}
```

---

#### `generate_id`

Generate a new UUID for a concept.

**Input:** `{}`

**Output:**
```json
{
  "success": true,
  "data": {"id": "550e8400-e29b-41d4-a716-446655440000"}
}
```

---

#### `health_check`

Check the health of the server and Python sidecar.

**Input:** `{}`

**Output:**
```json
{
  "success": true,
  "data": {
    "server": "ok",
    "python_sidecar": {
      "status": "ok",
      "services": {
        "embeddings": true,
        "ner": true,
        "vector_index": true
      },
      "index_stats": {
        "total_vectors": 42,
        "dimension": 768
      }
    }
  }
}
```

---

## Troubleshooting

### Common Issues

#### "Python sidecar failed to start"

**Symptoms:** Server hangs or errors on startup.

**Solutions:**
1. Check Python is installed: `python3 --version`
2. Verify virtual environment is activated
3. Check port 8787 is free: `lsof -i :8787`
4. Check Python dependencies: `pip list | grep fastapi`

```bash
# Manual test
cd python-sidecar
source venv/bin/activate
python main.py
# Should output: "Uvicorn running on http://127.0.0.1:8787"
```

---

#### "Vector dimension mismatch"

**Symptoms:** Error when saving vectors.

**Solutions:**
- Ensure vectors have exactly 768 dimensions
- Check you're using `all-MiniLM-L6-v2` model
- Verify: `len(vector) == 768`

---

#### "spaCy model not found"

**Symptoms:** NER operations fail.

**Solutions:**
```bash
cd python-sidecar
source venv/bin/activate
python -m spacy download en_core_web_sm
```

---

#### "FAISS index corrupted"

**Symptoms:** Search operations fail or return wrong results.

**Solutions:**
```bash
# Delete and regenerate the index
rm data/faiss.index data/id_map.json
# Restart the server - index will rebuild from database
```

---

#### "Database locked"

**Symptoms:** Operations timeout or fail with lock errors.

**Solutions:**
1. Ensure only one server instance is running
2. Check for zombie processes: `ps aux | grep politician`
3. Delete WAL files if corrupted:
   ```bash
   rm data/concepts.db-wal data/concepts.db-shm
   ```

---

### Debug Mode

Enable verbose logging:

```bash
export LOG_LEVEL=debug
npm run dev
```

---

### Health Check

Test the Python sidecar directly:

```bash
curl http://localhost:8787/health
```

Expected response:
```json
{
  "status": "ok",
  "services": {
    "embeddings": true,
    "ner": true,
    "vector_index": true
  },
  "index_stats": {
    "total_vectors": 0,
    "dimension": 768,
    "id_count": 0
  }
}
```

---

## Development

### Project Structure

```
politician/
├── src/                    # TypeScript source
│   ├── index.ts           # Entry point
│   ├── server.ts          # MCP server setup
│   ├── db/
│   │   ├── schema.ts      # Drizzle ORM schema
│   │   └── client.ts      # Database connection
│   ├── types/
│   │   ├── concept.ts     # Concept types & Zod schemas
│   │   └── thoughtform.ts # ThoughtForm types & schemas
│   ├── services/
│   │   ├── python-bridge.ts     # HTTP client for sidecar
│   │   ├── concept.service.ts   # CRUD operations
│   │   └── conversion.service.ts # Conversion logic
│   └── commands/
│       ├── save.ts        # Save command handlers
│       ├── read.ts        # Read command handlers
│       └── convert.ts     # Convert command handlers
├── python-sidecar/         # Python ML services
│   ├── main.py            # FastAPI server
│   ├── embeddings.py      # sentence-transformers
│   ├── ner.py             # spaCy NER
│   ├── vector_index.py    # FAISS index
│   └── requirements.txt   # Python dependencies
├── data/                   # Runtime data (gitignored)
│   ├── concepts.db        # SQLite database
│   ├── faiss.index        # FAISS vector index
│   └── id_map.json        # FAISS ID mapping
├── dist/                   # Compiled JavaScript (gitignored)
├── package.json
├── tsconfig.json
└── drizzle.config.ts
```

### Adding a New Tool

1. Define the handler in `src/commands/`:

```typescript
export async function myNewTool(input: unknown): Promise<ConceptResponse<MyOutput>> {
  // Validate input with Zod
  // Perform operation
  // Return result
}

export const myCommands = {
  my_new_tool: {
    description: "Description for Claude",
    inputSchema: { /* JSON Schema */ },
    handler: myNewTool,
  },
};
```

2. Register in `src/server.ts`:

```typescript
import { myCommands } from "./commands/my-commands.js";

const commands = { ...allCommands, ...myCommands };
```

3. Rebuild: `npm run build`

### Running Tests

```bash
# Type checking
npm run typecheck

# TODO: Add test framework
npm test
```

---

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run type checking: `npm run typecheck`
5. Commit with a descriptive message
6. Push to your fork: `git push origin feature/my-feature`
7. Open a Pull Request

### Code Style

- TypeScript: Use strict mode, prefer explicit types
- Python: Follow PEP 8, use type hints
- Commits: Use conventional commit messages

### Reporting Issues

Please include:
- Node.js and Python versions
- Operating system
- Error messages and logs
- Steps to reproduce

---

## License

MIT License

Copyright (c) 2024

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
