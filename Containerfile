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

# mediasoup picks its prebuilt media worker by the host's kernel major version. The "kernel7" build
# does not run inside a container build (CI runners on kernel 7 hit this: the check fails and it falls
# back to compiling, which needs python and a toolchain this image does not have), while the
# "kernel6" build runs everywhere from kernel 6 up. So a host above kernel 6 uses the kernel6 build.
# Only this one npm ci is affected (NODE_OPTIONS is not kept in the image).
RUN printf '%s\n' "const os = require('os');" "const real = os.release.bind(os);" \
      "os.release = () => { const r = real(); return Number(r.split('.')[0]) > 6 ? '6.0.0' : r; };" > /tmp/kernel6.js
COPY package.json package-lock.json ./
RUN NODE_OPTIONS="--require /tmp/kernel6.js" npm ci --omit=dev && rm -f /tmp/kernel6.js

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
