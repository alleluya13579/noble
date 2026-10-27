# Build from the repository root: docker build -f backend/Dockerfile -t noble .
FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY backend/schema.sql backend/schema.sqlite.sql backend/openapi.yaml ./
COPY backend/migrations ./migrations
COPY backend/src ./src
COPY web /app/web
ENV NODE_ENV=production NOBLE_ENV=production PORT=8080 DATABASE_PATH=/data/noble.sqlite UPLOAD_DIR=/data/uploads
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/ready || exit 1
CMD ["node", "src/server.js"]
