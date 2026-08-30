# Shared cache

Redis, read-through, with **version-keyed invalidation**.

## Why not delete-on-write

The obvious design is: write the product, then `DEL` the cache key. It is one
line and it is what most codebases do. It has a window that cannot be closed —
if the process dies, the pod is evicted, or the Redis call fails between the
database COMMIT and the DEL, the stale value survives until its TTL. Nothing
retries it, and nothing knows it was lost.

With one instance that window is small. With several stateless instances
behind a load balancer it is worse than small — it is invisible: the writer
deletes on *its* connection, and any instance that read the old value into its
own memory keeps serving it. That is the failure mode the in-memory memo this
replaces would have had.

## What we do instead

A single row in Postgres holds a catalogue **version**. Every product write
bumps it **inside the same transaction** as the write itself.

The cache key contains that version:

    v1:products:count:gen:41        <- before the write
    v1:products:count:gen:42        <- after it

Invalidation is therefore not an action that can fail. It is a *consequence*
of the write committing: readers on the new version simply cannot address the
old entry. If the transaction rolls back, the version does not move and
nothing was invalidated — which is correct, because nothing changed.

Old keys are never deleted. They expire on their own TTL and are unreachable
long before that.

## The cost, stated plainly

A read now costs one extra Postgres query — fetching the version — on top of
the Redis lookup. That is a single-row primary-key read against a table with
one row, versus the `COUNT(*)` full scan it replaces. At 100,000 products
that is roughly three orders of magnitude cheaper, and it is bounded: it does
not grow with the catalogue, which is the entire problem with counting.

It is also behind the edge cache, so most requests never reach it at all.

## Failure behaviour

Fails **open**, and says so. If Redis is unreachable every read misses and
every write is discarded, so callers fall through to the database exactly as
they would on a cold cache. The site stays up and gets slower.

Silent degradation is the real risk — a cache that has been down for three
weeks looks identical to one that is merely cold. `RedisCacheStore` therefore
logs on the *transition* into and out of the unhealthy state rather than
per-operation, so an outage produces one loud line instead of ten thousand
that nobody reads.
