# Nano Banana MCP server — Streamable HTTP mode (see src/http.ts).
# Cloud Run builds this via `gcloud run deploy --source .` (see DEPLOY.md).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Install dependencies first for better layer caching (dev deps needed for tsc).
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Build, then drop dev dependencies from the final layer.
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev

EXPOSE 8080
CMD ["node", "build/http.js"]
