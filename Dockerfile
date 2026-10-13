# Etapa 1: constrói o painel (React) em arquivos estáticos.
FROM node:22-slim AS painel
WORKDIR /painel
COPY painel/package.json painel/package-lock.json ./
RUN npm ci
COPY painel/ ./
RUN npm run build

# Etapa 2: o servidor, que também entrega o painel pronto.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
COPY --from=painel /painel/dist ./painel/dist
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]
