"""Protected: generates the data, checks exactness, measures speedup. Do not edit in an experiment.

Usage: python3 eval.py dev|test   → prints `metric=<speedup>` (or `metric=0 error=...`).

The reference is the naive algorithm frozen here, so a speedup is relative to the starting point
and independent of the machine's absolute speed. Timings are the median of three runs of each.
"""
import random
import statistics
import sys
import time

import solution

SPLITS = {"dev": (1, 2500, 80, 8, 4), "test": (2, 3000, 90, 8, 5)}  # seed, n points, n queries, dims, k


def reference(points, queries, k):
    # Deliberately the same loops as the untouched solution.py, so the baseline speedup is 1.0.
    out = []
    for q in queries:
        dists = []
        for i, p in enumerate(points):
            d = 0.0
            for a, b in zip(p, q):
                d += (a - b) * (a - b)
            dists.append((d, i))
        dists.sort()
        out.append([i for _, i in dists[:k]])
    return out


def timed(fn, *args):
    runs = []
    for _ in range(3):
        t0 = time.perf_counter()
        fn(*args)
        runs.append(time.perf_counter() - t0)
    return statistics.median(runs)


def main():
    split = sys.argv[1] if len(sys.argv) > 1 else "dev"
    seed, n, m, dims, k = SPLITS[split]
    rng = random.Random(seed)
    points = [[rng.random() for _ in range(dims)] for _ in range(n)]
    queries = [[rng.random() for _ in range(dims)] for _ in range(m)]
    expected = reference(points, queries, k)
    got = solution.knn(points, queries, k)
    if got != expected:
        print("metric=0 error=output differs from the reference")
        return 1
    ref_t = timed(reference, points, queries, k)
    sol_t = timed(solution.knn, points, queries, k)
    print(f"metric={ref_t / sol_t:.3f} split={split} ref_s={ref_t:.3f} sol_s={sol_t:.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
