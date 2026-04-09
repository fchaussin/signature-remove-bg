#!/usr/bin/env python3
"""
Benchmark — API throughput under concurrent requests.

Requires a running server:  docker compose up -d
Run:  python3 benchmarks/bench_api.py [base_url]

Default base_url: http://localhost:8000
"""

import io
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx
import numpy as np
from PIL import Image


BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"


def make_png_bytes(size):
    """Generate a small PNG with a dark stroke."""
    img = Image.new("RGB", (size, size), (255, 255, 255))
    px = np.array(img)
    t = max(2, size // 50)
    for i in range(size):
        px[max(0, i - t):min(size, i + t), i] = [30, 30, 30]
    buf = io.BytesIO()
    Image.fromarray(px).save(buf, format="PNG")
    return buf.getvalue()


def send_extract(client, png_bytes):
    """POST /extract and return (status, elapsed_ms)."""
    t0 = time.perf_counter()
    resp = client.post(
        f"{BASE_URL}/extract",
        files={"file": ("bench.png", io.BytesIO(png_bytes), "image/png")},
    )
    return resp.status_code, (time.perf_counter() - t0) * 1000


def bench_throughput(png_bytes, concurrency, total_requests):
    """Run total_requests with given concurrency, return stats."""
    results = []
    with httpx.Client(timeout=30) as client:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(send_extract, client, png_bytes) for _ in range(total_requests)]
            for f in as_completed(futures):
                results.append(f.result())

    statuses = [r[0] for r in results]
    times = [r[1] for r in results]
    ok = statuses.count(200)
    avg = sum(times) / len(times)
    p50 = sorted(times)[len(times) // 2]
    p99 = sorted(times)[int(len(times) * 0.99)]
    total_s = max(times) / 1000  # wall clock ≈ slowest request
    rps = total_requests / total_s if total_s > 0 else 0

    return {
        "ok": ok,
        "total": total_requests,
        "avg_ms": avg,
        "p50_ms": p50,
        "p99_ms": p99,
        "rps": rps,
    }


def main():
    print("=" * 72)
    print("  Signature Remove Background — API Throughput Benchmark")
    print(f"  Target: {BASE_URL}")
    print("=" * 72)

    # Check server is up
    try:
        resp = httpx.get(f"{BASE_URL}/health", timeout=5)
        if resp.status_code != 200:
            print(f"\n  Server returned {resp.status_code} on /health. Is it running?")
            sys.exit(1)
    except httpx.ConnectError:
        print(f"\n  Cannot connect to {BASE_URL}. Start the server first.")
        sys.exit(1)

    scenarios = [
        ("500x500",   500, 1,  20),
        ("500x500",   500, 4,  20),
        ("500x500",   500, 8,  20),
        ("1000x1000", 1000, 1, 10),
        ("1000x1000", 1000, 4, 10),
        ("2000x2000", 2000, 1,  5),
        ("2000x2000", 2000, 4,  5),
    ]

    print(f"\n  {'Image':<14} {'Concur':>6} {'Reqs':>6} {'OK':>6} {'Avg(ms)':>10} {'p50(ms)':>10} {'p99(ms)':>10} {'req/s':>8}")
    print("-" * 72)

    for label, size, conc, total in scenarios:
        png = make_png_bytes(size)
        stats = bench_throughput(png, conc, total)
        print(f"  {label:<14} {conc:>6} {total:>6} {stats['ok']:>6} {stats['avg_ms']:>10.1f} {stats['p50_ms']:>10.1f} {stats['p99_ms']:>10.1f} {stats['rps']:>8.1f}")

    print()


if __name__ == "__main__":
    main()
