FROM node:20-slim

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json ./
RUN npm install

# Install Playwright Chromium + all its OS-level dependencies
RUN npx playwright install --with-deps chromium

# Copy application code
COPY *.js ./

# Persistent data volume fuer Kundendaten (credentials, sessions, downloads)
RUN mkdir -p /data
VOLUME /data

ENV SCRAPER_API_KEY=""
ENV HEADLESS=true
ENV DEBUG=false
ENV DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 3000

# Health Check fuer Docker/Coolify
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "const http=require('http');http.get('http://localhost:3000/api/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
