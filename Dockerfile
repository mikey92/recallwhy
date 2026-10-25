# RecallWhy API in a container. With no settings it runs in sample mode (DuckDB stand-in over the
# recall snapshots in sample/ and the synthetic CSVs) and without a model, so it needs no credentials.
#   docker build -t recallwhy . && docker run --rm -p 8000:8000 recallwhy
#   curl -X POST localhost:8000/run -H 'Content-Type: application/json' -d @examples/input/example_1.json
# Live mode: pass --env-file .env with ZETARIS_BASE_URL=http://host.docker.internal:3000, the Zetaris
# login, METERLESS_BASE_URL=http://host.docker.internal:8088/v1 and METERLESS_RUNTIME_TOKEN (the
# Nightshift token file is not mounted). See README "Run it".
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV PORT=8000
# The API listens on 127.0.0.1 unless told otherwise; inside the container it must answer the published port.
# Set API_TOKEN to require "Authorization: Bearer <token>" on POST /run and /decide.
ENV HOST=0.0.0.0
EXPOSE 8000
CMD ["npx", "tsx", "src/api.ts"]
