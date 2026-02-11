# --- Etapa 1: Instalación de Dependencias ---
FROM node:20-alpine AS deps

WORKDIR /app

# ✅ CRÍTICO: Instalar git para dependencias que lo requieren
RUN apk add --no-cache git python3 make g++

COPY package*.json ./
RUN npm install --frozen-lockfile

# --- Etapa 2: Construcción de la Aplicación ---
FROM node:20-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build
RUN npm prune --production

# --- Etapa 3: Imagen Final de Producción ---
FROM node:20-alpine

WORKDIR /app

# ✅ Instalar dependencias del sistema
RUN apk add --no-cache \
    tzdata \
    tini \
    curl \
    && rm -rf /var/cache/apk/*

# ✅ Crear usuario no-root
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# ✅ Copiar dependencias y código
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/package*.json ./

# ✅ Crear directorios
RUN mkdir -p \
    /app/baileys_auth_info \
    /app/uploads \
    /app/logs \
    && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=America/Guayaquil

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "dist/main"]