# Container image for the livecode relay — works on Fly.io, Railway, Render,
# Google Cloud Run, or any host that runs containers.
FROM node:20-slim

WORKDIR /app

# install only what the relay needs
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the whole app (node_modules/.git/workspace/etc. are excluded via .dockerignore).
# We copy the FULL tree rather than a hand-picked file list so that adding a new runtime
# import — e.g. server.js now loads substrate.js -> icr.js -> lang-*.js — never silently
# breaks the image with "Cannot find module" again.
COPY . .

# hosts set $PORT; server.js already reads it (defaults to 1234)
EXPOSE 1234
CMD ["node", "server.js"]
