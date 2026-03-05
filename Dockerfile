FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist dist/

ENV NODE_ENV=production
EXPOSE 8787

USER node
CMD ["node", "dist/index.js"]
