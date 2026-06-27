FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data/.gitkeep ./data/.gitkeep
COPY dist/.gitkeep ./dist/.gitkeep
ENV NODE_ENV=production RELAYKIT_HOST=0.0.0.0 RELAYKIT_PORT=8787
EXPOSE 8787
CMD ["node", "src/panel.js"]
