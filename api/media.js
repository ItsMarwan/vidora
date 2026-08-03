import kv from './lib/kv.js';
import { assertOriginAllowed, getClientIp, rateLimit } from './lib/security.js';
import { ROOM_TTL_SECONDS, cleanMeta, getRoomKey } from './lib/party.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`party-media:${ip}`, 60, 60);
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

  const { roomId } = req.query;
  const key = getRoomKey(roomId);
  const raw = await kv.get(key);
  if (!raw) return res.status(404).json({ error: 'Room not found or the party has ended.' });
  const room = typeof raw === 'string' ? JSON.parse(raw) : raw;

  const { token, mediaMeta } = req.body || {};
  if (token !== room.hostToken) return res.status(403).json({ error: 'Only the host can do that.' });

  room.mediaMeta = cleanMeta(mediaMeta);
  room.lastState = null;
  room.updatedAt = Date.now();
  await kv.set(key, JSON.stringify(room), { ex: ROOM_TTL_SECONDS });
  res.status(200).json({ ok: true });
}
