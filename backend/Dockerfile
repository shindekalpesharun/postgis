FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
COPY scripts ./scripts
COPY tsconfig.json ./
COPY src ./src

RUN DATABASE_URL="postgresql://user:password@localhost:5432/database?schema=public" npm run db:generate \
    && npm run build

ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

CMD ["npm", "start"]
