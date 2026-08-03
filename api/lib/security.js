/**
 * VIDORA — SERVER SECURITY HELPERS
 * Used by every /api/* route: an origin allowlist ("origin lock") and a
 * simple IP-based rate limiter backed by the same KV store the rest of the
 * app already uses (no extra service to set up).
 */
import kv from './kv.js';

// Comma-separated list of allowed origins, e.g.
//   ALLOWED_ORIGINS=https://vidora.example.com,https://vidora.vercel.app
// If no explicit allowlist is configured in production, the API denies
// requests unless they come from the same host or a local development origin.
export function getAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  const configured = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.length) return configured;

  if (process.env.NODE_ENV === 'production') return [];

  return [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
  ];
}

export function assertOriginAllowed(req) {
  const allowed = getAllowedOrigins();
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = req.headers.host || req.headers['x-forwarded-host'];

  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost === host) return true;
    } catch {
      // ignore malformed origins
    }
  }

  if (origin && allowed.includes(origin)) return true;
  if (!origin && referer && allowed.some((a) => referer.startsWith(a))) return true;

  if (process.env.NODE_ENV !== 'production' && host) {
    const normalizedHost = String(host).toLowerCase();
    if (normalizedHost.includes('localhost') || normalizedHost.includes('127.0.0.1') || normalizedHost.includes('0.0.0.0')) {
      return true;
    }
  }

  return false;
}

export function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Fixed-window rate limiter: `limit` requests per `windowSeconds`, keyed by
 * whatever string you pass in (usually `${routeName}:${ip}`). Returns
 * { allowed, remaining }.
 */
export async function rateLimit(key, limit, windowSeconds) {
  const count = await kv.incr(key);
  if (count === 1) await kv.expire(key, windowSeconds);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}
