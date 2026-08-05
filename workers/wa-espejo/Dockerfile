FROM node:20-slim
# Baileys trae dependencias que npm clona desde git (libsignal): sin git el
# install muere con "spawn git ENOENT".
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs ./
# Solo lectura: este proceso jamás envía mensajes.
CMD ["node", "index.mjs"]
