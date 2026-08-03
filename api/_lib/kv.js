/**
 * Thin wrapper around @vercel/kv so the rest of the server code has one
 * place to import from. In local development, if the required KV env vars
 * are not present, we fall back to an in-memory store so the app can still
 * run without needing Redis configured.
 *
 * Lives under api/_lib/ (underscore prefix) so Vercel treats it as a plain
 * importable module instead of building it as its own serverless function.
 */
import { kv as vercelKv } from '@vercel/kv';

const hasKvConfig = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

const memoryStore = new Map();
const memoryKv = {
  async get(key) {
    return memoryStore.has(key) ? memoryStore.get(key) : null;
  },
  async set(key, value, opts = {}) {
    memoryStore.set(key, value);
    if (opts.ex) {
      setTimeout(() => memoryStore.delete(key), Number(opts.ex) * 1000);
    }
    return 'OK';
  },
  async del(key) {
    memoryStore.delete(key);
    return 1;
  },
  async incr(key) {
    const current = Number(memoryStore.get(key) || 0);
    const next = current + 1;
    memoryStore.set(key, String(next));
    return next;
  },
  async expire(key, seconds) {
    const value = memoryStore.get(key);
    if (value !== undefined) {
      setTimeout(() => memoryStore.delete(key), Number(seconds) * 1000);
    }
    return 1;
  },
};

export default hasKvConfig ? vercelKv : memoryKv;
