# The platform as one container: the API, plus the back office console (/console)
# and the member portal (/portal), which it serves unless SERVE_FRONTENDS=off. In
# production the front ends can be served from a bucket instead. Cloud Run runs it as the
# service, and as jobs for migrations, the end of day and token pruning (docs/deploy.md).
FROM node:25-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bin ./bin
COPY src ./src
COPY public ./public
COPY portal ./portal

USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
