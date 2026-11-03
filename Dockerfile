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

# Build static Vite frontend (dist/), bundled backend (dist/server.js), and pre-seeded PGlite DB (dist/ordaris-db)
RUN npm run build

# Prepare writable local-first PGlite & upload directories (supports non-root UID 1000 on Hugging Face Spaces)
RUN mkdir -p /app/.local/ordaris-db /app/.local/uploads /app/.local/logs && \
    chmod -R 777 /app/.local /app/dist

ENV NODE_ENV=production
ENV SERVE_STATIC=true
ENV PUBLIC_DEMO_SANDBOX=false
ENV DEMO_MODE=false
ENV AI_MODE=demo
ENV DB_DRIVER=pglite
ENV PGLITE_DATA_DIR=/app/dist/ordaris-db
ENV UPLOAD_DIR=/app/.local/uploads
ENV NODE_OPTIONS="--expose-gc --max-old-space-size=384"
ENV PORT=3000

EXPOSE 3000

# Generate a unique 256-bit CSPRNG AUTH_SECRET at container startup if none was injected via -e AUTH_SECRET=...
CMD ["sh", "-c", "export AUTH_SECRET=${AUTH_SECRET:-$(node -e \"process.stdout.write(require('crypto').randomBytes(32).toString('hex'))\")} && exec node --liftoff-only --no-wasm-tier-up --expose-gc --max-old-space-size=192 --max-semi-space-size=8 dist/server.js"]
