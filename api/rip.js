import crypto from 'crypto';
import { assertOriginAllowed, getClientIp, rateLimit } from './_lib/security.js';
import kv from './_lib/kv.js';

// Simple rip endpoint: fetches an embed page, extracts the first .m3u8
// URL it can find and stores the required headers + stream URL in KV
// under a short-lived token. Returns a proxied URL the client can use.

export default async function handler(req, res) {
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`rip:${ip}`, 60, 60);
  if (!rl.allowed) return res.status(429).json({ error: 'Rate limit' });

  const embed = String(req.query?.embed || req.body?.embed || '');
  if (!embed) return res.status(400).json({ error: 'Missing embed URL' });

  try {
    const u = new URL(embed);
    // Fetch the embed page
    const r = await fetch(u.toString(), { redirect: 'follow' });
    const text = await r.text();

    // crude regex for .m3u8 links
    const m = text.match(/https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*/i);
    if (!m) return res.status(404).json({ error: 'No m3u8 found' });
    const streamUrl = m[0];

    // headers likely required to fetch segments
    const headers = {
      referer: u.toString(),
      origin: u.origin,
      'user-agent': req.headers['user-agent'] || 'Vidora/1.0',
    };

    // store in KV under short token
    const token = `rip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    await kv.set(`rip:${token}`, JSON.stringify({ streamUrl, headers }), { ex: 300 });

    return res.status(200).json({ proxiedUrl: `/api/proxy?token=${encodeURIComponent(token)}`, streamUrl, headers });
  } catch (err) {
    console.error('rip error', err);
    return res.status(500).json({ error: 'Failed to rip embed' });
  }
}
