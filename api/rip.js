import { assertOriginAllowed, getClientIp, rateLimit } from './_lib/security.js';
import kv from './_lib/kv.js';

function normalizeUrl(value) {
  return String(value || '').replace(/\\\//g, '/').replace(/\\u003a/gi, ':');
}

function collectUrlsFromText(text) {
  const matches = new Set();
  const patterns = [
    new RegExp('https?:\\/\\/[^"\'<>\\s]+\\.m3u8(?:\\?[^"\'<>\\s]*)?', 'gi'),
    new RegExp('https?:\\\\/\\\\/[^"\'<>\\s]+\\\\.m3u8(?:\\\\?[^"\'<>\\s]*)?', 'gi'),
    new RegExp('[\'\"]([^"\'<>\\s]+\\.m3u8(?:\\?[^"\'<>\\s]*)?)[\'\"]', 'gi'),
    new RegExp('(?:file|src|source|url)\\s*[:=]\\s*[\'\"]([^"\'<>\\s]+\\.m3u8(?:\\?[^"\'<>\\s]*)?)[\'\"]', 'gi'),
  ];

  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const candidate = normalizeUrl(match[1] || match[0]);
      if (candidate && /\\.m3u8(?:\\?|$)/i.test(candidate)) {
        matches.add(candidate);
      }
    }
  }

  return [...matches];
}

export default async function handler(req, res) {
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`rip:${ip}`, 60, 60);
  if (!rl.allowed) return res.status(429).json({ error: 'Rate limit' });

  const embed = String(req.query?.embed || req.body?.embed || '');
  if (!embed) return res.status(400).json({ error: 'Missing embed URL' });

  console.log('[rip] request for embed=', embed);

  try {
    const u = new URL(embed);
    const headers = {
      referer: u.toString(),
      origin: u.origin,
      'user-agent': req.headers['user-agent'] || 'Vidora/1.0',
    };

    const pageRes = await fetch(u.toString(), { redirect: 'follow' });
    const pageText = await pageRes.text();
    let streamUrl = collectUrlsFromText(pageText)[0] || null;

    if (!streamUrl) {
      const assetUrls = [...new Set(
        [...pageText.matchAll(/(?:src|href)=['\"]([^'\"\\s]+(?:\\.js|\\.css|\\.json)[^'\"\\s]*)['\"]/gi)]
          .map((m) => normalizeUrl(m[1]))
          .filter(Boolean)
      )];

      for (const asset of assetUrls.slice(0, 25)) {
        try {
          const assetUrl = new URL(asset, u).toString();
          const assetRes = await fetch(assetUrl, { redirect: 'follow' });
          const assetText = await assetRes.text();
          const assetMatches = collectUrlsFromText(assetText);
          if (assetMatches.length) {
            streamUrl = assetMatches[0];
            break;
          }
        } catch (error) {
          console.warn('[rip] asset scan failed', asset, error && error.message);
        }
      }
    }

    if (!streamUrl) {
      const iframeUrl = /<iframe[^>]+src=['\"]([^'\"]+)['\"][^>]*>/i.exec(pageText)?.[1];
      if (iframeUrl) {
        try {
          const iframeFull = new URL(iframeUrl, u).toString();
          const iframeRes = await fetch(iframeFull, { redirect: 'follow' });
          const iframeText = await iframeRes.text();
          streamUrl = collectUrlsFromText(iframeText)[0] || null;
        } catch (error) {
          console.warn('[rip] iframe fetch failed', error && error.message);
        }
      }
    }

    if (!streamUrl) {
      console.log('[rip] no m3u8 found through provider scan');
      return res.status(404).json({ error: 'No m3u8 found' });
    }

    const token = `rip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    await kv.set(`rip:${token}`, JSON.stringify({ streamUrl, headers }), { ex: 300 });

    return res.status(200).json({
      proxiedUrl: `/api/proxy?token=${encodeURIComponent(token)}`,
      streamUrl,
      headers,
    });
  } catch (err) {
    console.error('rip error', err);
    return res.status(500).json({ error: 'Failed to rip embed' });
  }
}
