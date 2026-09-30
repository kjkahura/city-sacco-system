# The platform as one container: the API, the back office console (/console)
# and the member portal (/portal). Cloud Run runs it as the service, and as
# jobs for migrations, the end of day and token pruning (docs/deploy.md).
FROM node:22-bookworm-slim

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
