# -------------------------------------------------------------------
# Dockerfile para el Backend (NestJS)
# -------------------------------------------------------------------

# --- Etapa 1: Instalación de Dependencias ---
# Se utiliza Node.js 20 Alpine como base.
FROM node:20-alpine AS deps

WORKDIR /app
COPY package*.json ./
# Se instalan las dependencias usando --frozen-lockfile para compilaciones reproducibles.
RUN npm install --frozen-lockfile

# --- Etapa 2: Construcción de la Aplicación ---
FROM node:20-alpine AS builder
WORKDIR /app
# Se copian las dependencias ya instaladas de la etapa anterior.
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Se compila el código de TypeScript a JavaScript.
RUN npm run build

# --- Etapa 3: Imagen Final de Producción ---
FROM node:20-alpine
WORKDIR /app

# Se instala el paquete 'tzdata' para asegurar que el sistema operativo del contenedor
# reconozca la zona horaria "America/Guayaquil".
RUN apk add --no-cache tzdata

# Se copian solo los artefactos necesarios para ejecutar la aplicación.
# Esto mantiene la imagen final lo más pequeña y segura posible.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Se expone el puerto en el que corre la aplicación NestJS.
EXPOSE 3000

# Se define el comando para iniciar el servidor de producción.
CMD ["node", "dist/main"]