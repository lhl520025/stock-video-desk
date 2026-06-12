FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
COPY data ./data

ENV NODE_ENV=production
ENV PORT=5173

EXPOSE 5173

CMD ["node", "server.js"]
