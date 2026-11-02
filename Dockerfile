# Ordaris Runtime — Free-Tier Cloud Deployment Dockerfile
# Compatible with Render Free Tier, Koyeb Free Tier, Hugging Face Spaces (Docker), Railway, and Fly.io.

FROM node:22-slim

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json .npmrc* ./

# Install dependencies
RUN npm install --legacy-peer-deps --no-audit --no-fund

# Copy application source
COPY . .

# Build static Vite frontend (dist/) and bundled backend (dist/server.js)
RUN npm run build

# Prepare writable local-first PGlite & upload directories (supports non-root UID 1000 on Hugging Face Spaces)
RUN mkdir -p /app/.local/ordaris-db /app/.local/uploads /app/.local/logs && \
    chmod -R 777 /app/.local

ENV NODE_ENV=development
ENV SERVE_STATIC=true
ENV DEMO_MODE=true
ENV AI_MODE=demo
ENV DB_DRIVER=auto
ENV PGLITE_DATA_DIR=/app/.local/ordaris-db
ENV UPLOAD_DIR=/app/.local/uploads
ENV NODE_OPTIONS="--max-old-space-size=256"
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/server.js"]
