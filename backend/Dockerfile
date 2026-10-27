FROM node:22-alpine
WORKDIR /app
COPY package.json schema.sql schema.sqlite.sql openapi.yaml ./
COPY src ./src
ENV NODE_ENV=production NOBLE_ENV=production PORT=8080 DATABASE_PATH=/data/noble.sqlite UPLOAD_DIR=/data/uploads
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "src/server.js"]
