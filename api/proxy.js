import { assertOriginAllowed, getClientIp, rateLimit } from './_lib/security.js';
import kv from './_lib/kv.js';

export default async function handler(req, res) {
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`proxy:${ip}`, 120, 60);
  if (!rl.allowed) return res.status(429).json({ error: 'Rate limit' });

  const token = String(req.query?.token || req.body?.token || '');
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const entry = await kv.get(`rip:${token}`);
  if (!entry) return res.status(404).json({ error: 'Unknown or expired token' });
  let parsed;
  try { parsed = JSON.parse(entry); } catch { return res.status(500).json({ error: 'Bad token data' }); }

  const target = parsed.streamUrl;
  if (!target) return res.status(404).json({ error: 'No stream URL' });

  try {
    const forwardHeaders = { ...(parsed.headers || {}) };
    // allow passthrough of Range header from client
    if (req.headers.range) forwardHeaders.Range = req.headers.range;

    const upstream = await fetch(target, { headers: forwardHeaders, method: req.method });
    res.status(upstream.status);
    upstream.headers.forEach((val, key) => {
      // avoid exposing hop-by-hop headers
      if (['transfer-encoding', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade'].includes(key.toLowerCase())) return;
      res.setHeader(key, val);
    });
    const body = await upstream.arrayBuffer();
    res.send(Buffer.from(body));
  } catch (err) {
    console.error('proxy error', err);
    return res.status(502).json({ error: 'Upstream fetch failed' });
  }
}
