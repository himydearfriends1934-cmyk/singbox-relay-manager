FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data /app/dist
ENV NODE_ENV=production RELAYKIT_HOST=0.0.0.0 RELAYKIT_PORT=8787
EXPOSE 8787
CMD ["node", "src/panel.js"]
