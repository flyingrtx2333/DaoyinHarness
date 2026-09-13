FROM node:22.23.1-bookworm-slim
WORKDIR /opt
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY runtime.mjs build.mjs /opt/harness/
ENV PATH="/opt/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"
WORKDIR /app
USER 1000:1000
CMD ["/opt/node_modules/.bin/tsx","server.ts"]
