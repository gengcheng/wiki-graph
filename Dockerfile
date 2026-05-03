FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/ ./public/
COPY skill/ ./skill/

EXPOSE 3000

CMD ["node", "server.js"]
