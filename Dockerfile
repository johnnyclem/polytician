# =============================================================================
# Politician MCP Server - Multi-stage Dockerfile
# =============================================================================
# This Dockerfile builds a container with both Node.js and Python runtimes
# for running the MCP server and Python ML sidecar together.
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Node.js Builder
# -----------------------------------------------------------------------------
FROM node:20-slim AS node-builder

WORKDIR /build

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --only=production=false

# Copy TypeScript source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# -----------------------------------------------------------------------------
# Stage 2: Python Builder
# -----------------------------------------------------------------------------
FROM python:3.11-slim AS python-builder

WORKDIR /build

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Copy Python requirements
COPY python-sidecar/requirements.txt ./

# Create virtual environment and install dependencies
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Download spaCy model
RUN python -m spacy download en_core_web_sm

# -----------------------------------------------------------------------------
# Stage 3: Production Runtime
# -----------------------------------------------------------------------------
FROM python:3.11-slim AS production

# Install security updates and minimal dependencies
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
        curl \
        ca-certificates \
        dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get autoremove -y \
    && apt-get clean

# Install Node.js securely
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r politician && \
    useradd -r -g politician -d /app -s /sbin/nologin politician

# -----------------------------------------------------------------------------
# Stage 4: Runtime (development)
# -----------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

# Install Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Python virtual environment from builder
COPY --from=python-builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy Node.js dependencies and built code
COPY --from=node-builder /build/node_modules ./node_modules
COPY --from=node-builder /build/dist ./dist
COPY --from=node-builder /build/package.json ./

# Copy Python sidecar source
COPY python-sidecar/ ./python-sidecar/

# Create directories with proper permissions
RUN mkdir -p /app/data /app/logs /tmp && \
    chown -R politician:politician /app && \
    chmod 700 /app/data && \
    chmod 755 /app/logs && \
    chmod 1777 /tmp

# Switch to non-root user
USER politician

# Set environment variables (production secure defaults)
ENV NODE_ENV=production
ENV SIDECAR_HOST=127.0.0.1
ENV SIDECAR_PORT=8787
ENV DB_PATH=/app/data/concepts.db
ENV LOG_LEVEL=warn

# NO EXPOSE for production - sidecar is internal only

# Enhanced health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8787/health').read()"

# Volume for persistent data (restricted permissions)
VOLUME ["/app/data", "/app/logs"]

# Start the MCP server (which spawns the Python sidecar)
CMD ["node", "dist/index.js"]
