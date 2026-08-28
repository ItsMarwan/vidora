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

  console.log('[rip] request for embed=', embed);

  try {
    const u = new URL(embed);
    // Fetch the embed page
    const r = await fetch(u.toString(), { redirect: 'follow' });
    const text = await r.text();
    console.log(`[rip] fetched ${u.toString()} status=${r.status} contentLength=${text.length}`);

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
      if (iframeUrl) console.log('[rip] found iframe src=', iframeUrl);
      if (iframeUrl) {
        try {
          const iframeFull = new URL(iframeUrl, u).toString();
          const r2 = await fetch(iframeFull, { redirect: 'follow' });
          const t2 = await r2.text();
          console.log(`[rip] fetched iframe ${iframeFull} status=${r2.status} contentLength=${t2.length}`);
          streamUrl = firstMatch(/(https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*)/i, t2) || firstMatch(/(https?:\\\/\\\/[^"'<>\s]+\\\.m3u8[^"'<>\s]*)/i, t2)?.replace(/\\\//g, '/');
        } catch (e) {
          console.warn('[rip] iframe fetch failed', e && e.message);
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

    if (!streamUrl) {
      console.log('[rip] no m3u8 found in embed or iframe; returning 404');
      // As a last resort, try a headless browser to let embed JS run and
      // observe network requests for an m3u8. This requires Playwright to
      // be installed in the deployment environment. If it's not present,
      // return 404 but indicate Playwright is missing for debugging.
      try {
        const { chromium } = await import('playwright');
        console.log('[rip] launching headless browser to observe network');
        const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        let found = null;
        page.on('response', async (response) => {
          try {
            const url = response.url();
            if (/\.m3u8(\?|$)/i.test(url) && !found) {
              found = { url, headers: response.headers() };
              console.log('[rip] playwright captured m3u8', url);
            }
          } catch (e) {}
        });
        await page.goto(u.toString(), { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
        // wait up to 6s for any m3u8 requests
        const startWait = Date.now();
        while (!found && Date.now() - startWait < 6000) {
          // small sleep
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 200));
        }
        if (found) {
          streamUrl = found.url;
          // merge headers captured; prefer captured headers
          const headersCaptured = Object.assign({}, found.headers || {});
          const headersFinal = Object.assign({}, headers, headersCaptured);
          await browser.close();
          const token2 = `rip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
          await kv.set(`rip:${token2}`, JSON.stringify({ streamUrl, headers: headersFinal }), { ex: 300 });
          console.log('[rip] stored token via playwright', token2);
          return res.status(200).json({ proxiedUrl: `/api/proxy?token=${encodeURIComponent(token2)}`, streamUrl, headers: headersFinal });
        }
        await browser.close();
        console.log('[rip] playwright did not observe m3u8');
      } catch (playErr) {
        console.log('[rip] playwright not available or failed:', playErr && playErr.message);
        // fallthrough to 404
      }
      return res.status(404).json({ error: 'No m3u8 found' });
    }

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
