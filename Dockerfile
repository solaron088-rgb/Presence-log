FROM node:20-alpine

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    libc6-compat \
    git

WORKDIR /app

COPY package.json ./

RUN npm install --production

COPY index.js ./

RUN mkdir -p /app/auth_info

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "index.js"]
