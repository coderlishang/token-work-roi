FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci

COPY src ./src
COPY config ./config
COPY public ./public
COPY data/.gitkeep ./data/.gitkeep
COPY data/official-pricing.json ./data/official-pricing.json
COPY scripts/build-runtime.ts ./scripts/build-runtime.ts
COPY index.html tsconfig.json vite.config.ts ./
RUN npm run build && node scripts/build-runtime.ts && npm prune --omit=dev

ENV PORT=4173
ENV HOST=127.0.0.1
EXPOSE 4173

CMD ["node", "dist-runtime/server.mjs"]
