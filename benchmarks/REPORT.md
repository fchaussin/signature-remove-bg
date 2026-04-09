# Benchmark Report

**Date**: 2026-04-09 14:51 UTC
**App version**: 0.3.0
**Python**: 3.12.3 | **NumPy**: 2.4.4 | **Pillow**: 12.2.0
**Platform**: Linux 5.15.167.4-microsoft-standard-WSL2 (x86_64)
**Runs per size**: 5

## extract_signature()

| Resolution | Pixels | Avg (ms) | Peak mem (MB) |
|-----------|-------:|--------:|--------------:|
| 100x100 | 10,000 | 1.2 | 0.8 |
| 500x500 | 250,000 | 21.9 | 20.5 |
| 1000x1000 | 1,000,000 | 81.4 | 82.0 |
| 2000x2000 | 4,000,000 | 435.2 | 328.1 |
| 3000x3000 | 9,000,000 | 1348.0 | 738.1 |
| 5000x5000 | 25,000,000 | 4247.0 | 2050.4 |

## detect_presets()

| Resolution | Pixels | Avg (ms) | Peak mem (MB) |
|-----------|-------:|--------:|--------------:|
| 100x100 | 10,000 | 1.0 | 0.5 |
| 500x500 | 250,000 | 5.3 | 11.2 |
| 1000x1000 | 1,000,000 | 23.3 | 45.0 |
| 2000x2000 | 4,000,000 | 128.5 | 180.1 |
| 3000x3000 | 9,000,000 | 481.4 | 405.4 |
| 5000x5000 | 25,000,000 | 1325.2 | 1126.6 |

## Observations

- Images up to ~1000x1000: extraction under 100 ms
- Time and memory scale linearly with pixel count
- `detect_presets()` is ~3-5x faster than `extract_signature()`
- Docker limit of 128 MB RAM is suitable for images up to ~1000x1000
