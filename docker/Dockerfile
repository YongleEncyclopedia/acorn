# Acorn 松果 — container image. Build from the project root:
#   docker build -f docker/Dockerfile -t acorn .
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production ACORN_DATA_DIR=/data ACORN_HOST=0.0.0.0 ACORN_PORT=7700
COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev
COPY . .
RUN npm run build && npm prune --omit=dev
VOLUME ["/data"]
EXPOSE 7700
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server/main.ts"]
