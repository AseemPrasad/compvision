# ==========================================================================
# IBVAP — Intelligent Border Video Analytics Platform
# Multi-stage Dockerfile
#
# Stage 1 (builder): full Debian + build toolchain to compile native addons
#   (better-sqlite3, canvas, onnxruntime-node's prebuilt fetch, tfjs-node's
#   native binding). Alpine is deliberately avoided — musl libc is a known
#   source of build/runtime failures for these exact packages.
# Stage 2 (runtime): slim Debian + only the shared libraries actually needed
#   at runtime (no compilers, no -dev headers), plus ffmpeg for stream
#   ingestion. Both stages use the same Debian release (bookworm) so glibc
#   versions match and compiled .node binaries from the builder work
#   unmodified in the runtime image.
# ==========================================================================

# ---------- Stage 1: builder ----------
FROM node:22-bookworm AS builder

# Build-time system dependencies:
#   python3, make, g++     -> node-gyp toolchain (better-sqlite3, canvas)
#   pkg-config + *-dev libs -> canvas's Cairo/Pango/JPEG/GIF/RSVG bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libpixman-1-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching — this layer only
# rebuilds when package.json/package-lock.json actually change).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Now bring in the rest of the source.
COPY . .

# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim AS runtime

# Runtime system dependencies:
#   ffmpeg                  -> RTSP/MJPEG/MP4 ingestion (CameraManager.js)
#   libcairo2, libpango...  -> canvas's runtime shared libs (no -dev needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    libpixman-1-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring over the already-compiled node_modules (native .node binaries and
# all) plus the application source from the builder stage.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

# Runtime data directories. ai-engine/models, assets/demo_videos,
# storage/, and /app/data are all expected to be volume-mounted in
# docker-compose.yml — these mkdir calls just ensure the paths exist even
# if someone runs the image standalone without those mounts.
RUN mkdir -p /app/data \
             /app/storage/snapshots \
             /app/storage/clips \
             /app/assets/demo_videos \
             /app/ai-engine/models

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

EXPOSE 4000

# Basic liveness check against the health endpoint — no curl/wget in the
# slim image, so this uses Node's own http client directly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/api/health', res => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
