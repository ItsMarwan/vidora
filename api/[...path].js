import { assertOriginAllowed, getClientIp, rateLimit } from './lib/security.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';

// The client calls /api/tmdb/<same path TMDB itself uses>, e.g.
//   /api/tmdb/trending/movie/week
//   /api/tmdb/movie/12345
// This forwards it to TMDB with the real API key attached server-side —
// the key is never sent to, or visible from, the browser.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`tmdb:${ip}`, 60, 60);
  res.setHeader('X-RateLimit-Limit', '60');
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests, slow down.' });

  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'demo_mode' });

  const pathParts = Array.isArray(req.query.path) ? req.query.path : [req.query.path];
  const tmdbPath = '/' + pathParts.filter(Boolean).join('/');

  const url = new URL(TMDB_BASE + tmdbPath);
  url.searchParams.set('api_key', apiKey);
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path') continue;
    url.searchParams.set(key, Array.isArray(value) ? value[0] : value);
  }

  try {
    const upstream = await fetch(url.toString());
    const body = await upstream.text();
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.setHeader('Content-Type', 'application/json');
    res.status(upstream.status).send(body);
  } catch (err) {
    console.error('[api/tmdb] upstream error:', err);
    res.status(502).json({ error: 'Upstream error' });
  }
}
