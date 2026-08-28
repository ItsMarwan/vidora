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

    // Try multiple heuristics to find an .m3u8 URL in the embed HTML.
    function firstMatch(regex, srcText) {
      const mm = srcText.match(regex);
      return mm ? mm[1] || mm[0] : null;
    }

    // 1) raw URL
    let streamUrl = firstMatch(/(https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i, text);

    // 2) escaped JS string like "https:\/\/...\.m3u8"
    if (!streamUrl) {
      const esc = firstMatch(/(https?:\\\/\\\/[^"'<>\s]+\\\.m3u8[^"'<>\s]*)/i, text);
      if (esc) streamUrl = esc.replace(/\\\//g, '/');
    }

    // 3) common JS key patterns: file: '...', source: '...'
    if (!streamUrl) {
      streamUrl = firstMatch(/file\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i, text)
        || firstMatch(/source\s*[:=]\s*["']([^"']+\.m3u8[^"']*)["']/i, text)
        || firstMatch(/['"](https?:\\\/\\\/[^"']+\\\.m3u8[^"']*)['"]/i, text);
      if (streamUrl && streamUrl.includes('\\/')) streamUrl = streamUrl.replace(/\\\//g, '/');
    }

    // 4) If still not found, look for iframe src and fetch that page too (one level deep)
    if (!streamUrl) {
      const iframeUrl = firstMatch(/<iframe[^>]+src=["']([^"']+)["'][^>]*>/i, text);
      if (iframeUrl) {
        try {
          const r2 = await fetch(iframeUrl, { redirect: 'follow' });
          const t2 = await r2.text();
          streamUrl = firstMatch(/(https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i, t2) || firstMatch(/(https?:\\\/\\\/[^"'<>\s]+\\\.m3u8[^"'<>\s]*)/i, t2)?.replace(/\\\//g, '/');
        } catch (e) {
          // ignore iframe fetch errors
        }
      }
    }

    // 5) try to find large base64 blobs and decode them to search for URLs
    if (!streamUrl) {
      const b64 = firstMatch(/['"]([A-Za-z0-9+\/=]{64,})['"]/i, text);
      if (b64) {
        try {
          const buf = Buffer.from(b64, 'base64');
          const dec = buf.toString('utf8');
          streamUrl = firstMatch(/(https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i, dec) || null;
        } catch {}
      }
    }

    if (!streamUrl) return res.status(404).json({ error: 'No m3u8 found' });

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
