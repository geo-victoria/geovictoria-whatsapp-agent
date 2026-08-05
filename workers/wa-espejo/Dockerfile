FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.mjs ./
# Solo lectura: este proceso jamás envía mensajes.
CMD ["node", "index.mjs"]
