# RecallWhy API in a container. With no settings it runs in sample mode (DuckDB stand-in over the
# recall snapshots in sample/ and the synthetic CSVs) and without a model, so it needs no credentials.
#   docker build -t recallwhy . && docker run --rm -p 8000:8000 recallwhy
#   curl -X POST localhost:8000/run -H 'Content-Type: application/json' -d @examples/input/example_1.json
# Live mode: pass --env-file .env with ZETARIS_BASE_URL=http://host.docker.internal:3000 and the
# Zetaris login. Nightshift listens on 127.0.0.1 only, so model calls from inside a container need it
# exposed (or run `npm run api` on the host instead).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV PORT=8000
EXPOSE 8000
CMD ["npx", "tsx", "src/api.ts"]
