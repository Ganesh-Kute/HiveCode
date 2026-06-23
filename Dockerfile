# Container image for the livecode relay — works on Fly.io, Railway, Render,
# Google Cloud Run, or any host that runs containers.
FROM node:20-slim

WORKDIR /app

# install only what the relay needs
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# the relay + everything it loads at runtime: token.js (auth/scope verification)
# and public/ (the landing page, Control Room, and favicons it serves).
COPY server.js token.js ./
COPY public ./public

# hosts set $PORT; server.js already reads it (defaults to 1234)
EXPOSE 1234
CMD ["node", "server.js"]
