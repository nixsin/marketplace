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
      socket: {
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
    // Best effort. A cache that will not close must not stop the process
    // exiting -- most of all in tests, where a hung handle looks like a
    // failing suite.
    try {
      await this.client.quit();
    } catch {
      this.client.destroy();
    }
  }
}
