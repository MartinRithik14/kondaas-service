FROM node:20-alpine

WORKDIR /app

# Puppeteer will read this automatically at runtime — nothing extra needed
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NODE_ENV=production

# Alpine's chromium package + minimal font/rendering deps
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3000
CMD ["node", "index.js"]