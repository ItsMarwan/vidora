import kv from './lib/kv.js';
import { assertOriginAllowed, getClientIp, rateLimit } from './lib/security.js';
import { ROOM_TTL_SECONDS, getRoomKey } from './lib/party.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`party-leave:${ip}`, 60, 60);
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

  const { roomId } = req.query;
  const key = getRoomKey(roomId);
  const raw = await kv.get(key);
  if (!raw) return res.status(200).json({ ok: true });

  const room = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const { token } = req.body || {};

  if (token === room.hostToken) {
    await kv.del(key);
    return res.status(200).json({ ok: true, ended: true });
  }
  const guestEntry = Object.entries(room.guests).find(([, g]) => g.token === token);
  if (guestEntry) {
    delete room.guests[guestEntry[0]];
    room.updatedAt = Date.now();
    await kv.set(key, JSON.stringify(room), { ex: ROOM_TTL_SECONDS });
  }
  res.status(200).json({ ok: true });
}
