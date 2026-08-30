import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { createClient, type RedisClientType } from 'redis';
import type { CacheStore } from './cache-store';

/**
 * Redis-backed shared cache.
 *
 * FAILS OPEN, ALWAYS. Every method swallows connection and command errors and
 * behaves like a miss, so an unreachable Redis makes the site slower and never
 * makes it wrong -- callers already have to handle a miss, and the database
 * remains the source of truth.
 *
 * Silent degradation is the actual risk here: a cache that has been down for
 * three weeks is indistinguishable, from the outside, from one that is merely
 * cold. So health is tracked as a STATE and logged only on transition. An
 * outage produces one loud line and one recovery line, rather than ten
 * thousand identical warnings that train everyone to filter them out.
 *
 * The client is created with reconnection handled by the driver and NO
 * blocking connect at boot: an API that refuses to start because a cache is
 * unavailable has turned an optional dependency into a required one.
 */
@Injectable()
export class RedisCacheStore implements CacheStore, OnModuleDestroy {
  private readonly logger = new Logger('Cache');
  private readonly client: RedisClientType;
  private healthy = true;

  constructor(url: string) {
    this.client = createClient({
      url,
      // WITHOUT THIS, "fails open" is not true. node-redis queues commands
      // issued while disconnected and replays them once a connection is
      // established -- so against an unreachable Redis a `get()` does not
      // reject, it simply never settles. The catch blocks below never run,
      // the caller never falls through to the database, and the request hangs
      // until something upstream times out.
      //
      // Caught by running the e2e suite with REDIS_URL pointing at a closed
      // port: every test timed out rather than passing on the null path.
      // With the queue disabled a command fails immediately while
      // disconnected, which is what the error handling was written for.
      disableOfflineQueue: true,
      socket: {
        // Bounded so a connect attempt cannot hold a request open either.
        connectTimeout: 1_000,
        // Caps the backoff rather than growing it without bound, so a Redis
        // that comes back after an hour is picked up within seconds instead
        // of after the next exponential step.
        reconnectStrategy: (retries) => Math.min(retries * 100, 3_000),
      },
    });

    // The driver emits 'error' for connection failures. Without a listener,
    // Node treats it as an unhandled 'error' event and CRASHES the process --
    // which would turn "cache is down" into "API is down", the exact
    // inversion this class exists to prevent.
    this.client.on('error', (error: Error) => this.markUnhealthy(error));
    this.client.on('ready', () => this.markHealthy());

    // Not awaited. Boot must not depend on the cache being reachable.
    void this.client
      .connect()
      .catch((error: Error) => this.markUnhealthy(error));
  }

  private markUnhealthy(error: Error): void {
    if (!this.healthy) return; // already reported; do not repeat per-operation
    this.healthy = false;
    this.logger.error(
      JSON.stringify({
        msg: 'cache unavailable — serving every read from the database',
        error: error.message,
      }),
    );
  }

  private markHealthy(): void {
    if (this.healthy) return;
    this.healthy = true;
    this.logger.log(JSON.stringify({ msg: 'cache recovered' }));
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (error) {
      // Covers an unreachable Redis AND an unparseable value. The second is
      // worth treating as a miss rather than throwing: a corrupt or
      // shape-changed entry should degrade to a recompute, not a 500.
      this.markUnhealthy(error as Error);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds });
    } catch (error) {
      this.markUnhealthy(error as Error);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      this.markUnhealthy(error as Error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    // BOUNDED, because `quit()` on a client that never connected waits for a
    // connection that is not coming. That is not a test-only concern: a pod
    // rolling while Redis is unreachable would hang on shutdown, and the
    // orchestrator would eventually SIGKILL it. Found by an e2e `afterAll`
    // blowing its 5s hook timeout in CI, where REDIS_URL is set but no Redis
    // is running -- exactly the shape of the production case.
    //
    // `quit()` is still tried first: it drains in-flight commands, which
    // `destroy()` does not. It simply is not allowed to take forever.
    const SHUTDOWN_MS = 1_000;
    try {
      await Promise.race([
        this.client.quit(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('quit timed out')), SHUTDOWN_MS),
        ),
      ]);
    } catch {
      // Covers both a rejected quit and the timeout above.
      try {
        this.client.destroy();
      } catch {
        // `destroy()` throws "The client is closed" when it already is --
        // which is the common case here, since a failed `quit()` usually
        // closed it on the way out. Shutdown has exactly one job, and
        // throwing while doing it would fail the caller's teardown for a
        // state that is already what we wanted.
      }
    }
  }
}
