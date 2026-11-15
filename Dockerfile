# Exact requested Node.js runtime. Node 20 is EOL; deploy on a
# well-protected server and upgrade when possible.
FROM node:20.18.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv make g++ ffmpeg fonts-dejavu-core ca-certificates \
    && python3 -m venv /opt/yt \
    && /opt/yt/bin/pip install --no-cache-dir --pre "yt-dlp[default]" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js sqlite-driver.mjs download-helper.mjs video-editor.mjs render-resources.mjs local-render.mjs ./
COPY public ./public
ENV PATH="/opt/yt/bin:${PATH}" PORT=3000 YT_DLP_BIN=/opt/yt/bin/yt-dlp
EXPOSE 3000
CMD ["node", "server.js"]
