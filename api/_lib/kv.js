/**
 * Thin wrapper around @vercel/kv so the rest of the server code has one
 * place to import from. In local development, if the required KV env vars
 * are not present, we fall back to an in-memory store so the app can still
 * run without needing Redis configured.
 *
 * The in-memory store mirrors the small subset of Redis commands the app
 * uses (get/set/del/incr/expire plus hash ops for Watch Party). Expiry is
 * tracked with a per-key deadline and checked lazily, so re-setting a key
 * with a fresh TTL really does extend it (the old implementation scheduled
 * a delete timer per call, and the FIRST timer would still wipe the key
 * later even if it had been refreshed since).
 *
 * Lives under api/_lib/ (underscore prefix) so Vercel treats it as a plain
 * importable module instead of building it as its own serverless function.
 */
import { kv as vercelKv } from '@vercel/kv';

const hasKvConfig = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

const store = new Map();     // key -> string | Map (hash)
const deadlines = new Map(); // key -> epoch ms

function alive(key) {
  const d = deadlines.get(key);
  if (d !== undefined && d <= Date.now()) {
    store.delete(key);
    deadlines.delete(key);
    return false;
  }
  return store.has(key);
}

function hashFor(key, create) {
  if (!alive(key)) {
    if (!create) return null;
    store.set(key, new Map());
  }
  const h = store.get(key);
  return h instanceof Map ? h : null;
}

const memoryKv = {
  async get(key) {
    return alive(key) ? store.get(key) : null;
  },
  async set(key, value, opts = {}) {
    store.set(key, value);
    if (opts.ex) deadlines.set(key, Date.now() + Number(opts.ex) * 1000);
    else deadlines.delete(key);
    return 'OK';
  },
  async del(...keys) {
    let n = 0;
    for (const key of keys) {
      if (store.delete(key)) n += 1;
      deadlines.delete(key);
    }
    return n;
  },
  async incr(key) {
    const next = Number(alive(key) ? store.get(key) : 0) + 1;
    store.set(key, String(next));
    return next;
  },
  async expire(key, seconds) {
    if (!alive(key)) return 0;
    deadlines.set(key, Date.now() + Number(seconds) * 1000);
    return 1;
  },
  async hset(key, fields) {
    const h = hashFor(key, true);
    for (const [f, v] of Object.entries(fields)) h.set(f, v);
    return Object.keys(fields).length;
  },
  async hget(key, field) {
    const h = hashFor(key, false);
    return h && h.has(field) ? h.get(field) : null;
  },
  async hgetall(key) {
    const h = hashFor(key, false);
    return h && h.size ? Object.fromEntries(h) : null;
  },
  async hdel(key, ...fields) {
    const h = hashFor(key, false);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n += 1;
    return n;
  },
};

export default hasKvConfig ? vercelKv : memoryKv;
