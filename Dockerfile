FROM node:20-alpine

# Instalar dependencias del sistema para Baileys
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    libc6-compat

WORKDIR /app

# Copiar archivos de dependencias
COPY package.json ./

# Instalar dependencias
RUN npm install --production

# Copiar código fuente
COPY index.js ./

# Crear directorio de autenticación persistente
RUN mkdir -p /app/auth_info

# Exponer puerto
EXPOSE 3000

# Variables de entorno por defecto
ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "index.js"]
