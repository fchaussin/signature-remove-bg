FROM dhi.io/python:3.13-slim

LABEL org.opencontainers.image.source="https://github.com/fchaussin/signature-remove-bg"
LABEL org.opencontainers.image.description="Ultra lightweight signature background remover"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ backend/
COPY frontend/ frontend/

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
