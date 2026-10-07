# The climate-adaptation layer as one container: no dependencies beyond Node itself.
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY config ./config
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
