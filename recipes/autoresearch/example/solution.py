"""The editable file: exact k-nearest neighbours, deliberately naive.

`knn(points, queries, k)` returns, for each query, the indices of the k closest points by squared
Euclidean distance, ties broken by lower index. The evaluator checks the output against a
reference and times this function; only this file may change.
"""


def knn(points, queries, k):
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
