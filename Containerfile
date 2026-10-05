# NovaConnect — complete image for a fresh install (compose.yaml builds this).
#
# The NOVAAPP01 lab builds the same thing in two layers instead — Containerfile.base (system
# packages + npm dependencies) plus Containerfile.overlay (the app) — so a normal release only
# rebuilds the small top layer. Keep the three in step: a change to one of the steps below
# belongs in the matching base/overlay file too.
FROM node:22-slim
WORKDIR /app

# ffmpeg records meetings.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY views/ ./views/
COPY public/ ./public/
# Applied by src/migrate.js at startup.
COPY migrations/ ./migrations/

ARG RELEASE_VERSION=
ENV NOVACONNECT_RELEASE_VERSION=${RELEASE_VERSION}
ENV PORT=8080
ENV HTTPS_PORT=8443
ENV HOST=0.0.0.0
EXPOSE 8080 8443
CMD ["node", "src/server.js"]
