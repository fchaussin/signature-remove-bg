ARG DHI_BUILD=dhi.io/python:3.14-debian13-dev
ARG DHI_RUNTIME=dhi.io/python:3.14-debian13

FROM ${DHI_BUILD} AS builder

WORKDIR /build
COPY requirements.txt .
RUN python -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

FROM ${DHI_RUNTIME}

LABEL org.opencontainers.image.source="https://github.com/fchaussin/signature-remove-bg"
LABEL org.opencontainers.image.description="Ultra lightweight signature background remover"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    VIRTUAL_ENV=/opt/venv

COPY backend/ backend/
COPY frontend/ frontend/

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]

CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
