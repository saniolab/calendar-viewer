# syntax=docker/dockerfile:1

FROM node:24-alpine AS assets

WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY index.html vite.config.js ./
COPY src ./src

RUN pnpm run build \
    && test -s /app/dist/index.html

FROM python:3.12-slim AS runtime

WORKDIR /app

COPY app.py ./
COPY --from=assets /app/dist ./dist

RUN test -s /app/dist/index.html

RUN useradd --create-home --uid 10001 app
USER app

ENV BIND=0.0.0.0
ENV PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["python3", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8787') + '/health', timeout=2).read()"]

CMD ["python3", "app.py"]
