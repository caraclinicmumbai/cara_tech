// Redis connection for BullMQ. (Guide §5: lib/redis.ts)
// BullMQ requires `maxRetriesPerRequest: null` on its connection.
import IORedis from "ioredis";

const globalForRedis = globalThis as unknown as {
  redis: IORedis | undefined;
};

export const redis =
  globalForRedis.redis ??
  new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
    // Defer the TCP connection until the first command so importing the queue
    // (e.g. during `next build`) doesn't attempt to reach Redis.
    lazyConnect: true,
  });

if (process.env.NODE_ENV !== "production") globalForRedis.redis = redis;
