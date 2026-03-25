FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN cp -r public dist/public
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
ENV TRANSPORT=httpStream
ENV BASE_URL=http://localhost:8080
ENV DATA_DIR=/app/data

EXPOSE 8080
CMD ["node", "dist/google-docs/server.js"]