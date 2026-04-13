FROM python:3.14-slim AS builder

WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.14-slim

LABEL org.opencontainers.image.source="https://github.com/fchaussin/signature-remove-bg"
LABEL org.opencontainers.image.description="Ultra lightweight signature background remover"
LABEL org.opencontainers.image.licenses="MIT"

RUN groupadd --gid 1001 app && \
    useradd --uid 1001 --gid app --no-create-home app

WORKDIR /app

COPY --from=builder /install /usr/local

COPY --chown=app:app backend/ backend/
COPY --chown=app:app frontend/ frontend/

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
