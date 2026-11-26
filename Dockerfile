# Two stages: the build toolchain (typescript, tsx, eslint, test deps) stays in
# the builder; the runtime image gets only production node_modules, dist and
# public, and runs as the unprivileged `node` user.

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
# Copy only what the build needs, so local state (data/, .env, worktrees) can
# never reach the image even if .dockerignore misses it.
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
# tsc over the whole tree exceeds Node's default heap (local Docker builds fail
# with "heap out of memory"); the larger heap applies to this step only.
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build
# Prune here rather than `npm ci --omit=dev` in the runtime stage: the native
# modules (bcrypt, sharp) are already installed for this platform, so the
# runtime stage needs no build toolchain.
RUN npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV TRANSPORT=httpStream
ENV BASE_URL=http://localhost:8080
ENV DATA_DIR=/app/data

# package.json is needed at runtime: its "type": "module" makes dist/*.js ESM.
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./dist/public

# The file-fallback stores (no DATABASE_URL) write here and nowhere else.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 8080
CMD ["node", "dist/google-docs/server.js"]
