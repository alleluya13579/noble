# Build from the repository root: docker build -f backend/Dockerfile -t noble .
FROM node:22-alpine
WORKDIR /app/backend
COPY backend/package.json backend/schema.sql backend/schema.sqlite.sql backend/openapi.yaml ./
COPY backend/src ./src
COPY web /app/web
ENV NODE_ENV=production NOBLE_ENV=production PORT=8080 DATABASE_PATH=/data/noble.sqlite UPLOAD_DIR=/data/uploads
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
