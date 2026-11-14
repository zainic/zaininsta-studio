# Exact requested Node.js runtime. Node 20 is EOL; deploy on a
# well-protected server and upgrade when possible.
FROM node:20.18.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv make g++ ffmpeg ca-certificates \
    && python3 -m venv /opt/yt \
    && /opt/yt/bin/pip install --no-cache-dir yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js sqlite-driver.mjs ./
COPY public ./public
ENV PORT=3000 YT_DLP_BIN=/opt/yt/bin/yt-dlp
EXPOSE 3000
CMD ["node", "server.js"]
