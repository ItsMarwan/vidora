import kv from '../../lib/kv.js';
import { assertOriginAllowed, getClientIp, rateLimit } from '../../lib/security.js';
import { ROOM_TTL_SECONDS, getRoom, getRoomKey, saveRoom } from '../../lib/party.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`party-leave:${ip}`, 60, 60);
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

  const roomId = String(req.query.room || '').toLowerCase();
  if (!roomId) return res.status(400).json({ error: 'Missing room id.' });

  const room = await getRoom(roomId);
  if (!room) return res.status(200).json({ ok: true });

  const { token } = req.body || {};
  if (token === room.hostToken) {
    await kv.del(getRoomKey(roomId));
    return res.status(200).json({ ok: true, ended: true });
  }

  const guestEntry = Object.entries(room.guests || {}).find(([, g]) => g.token === token);
  if (guestEntry) {
    delete room.guests[guestEntry[0]];
    room.updatedAt = Date.now();
    await kv.set(getRoomKey(roomId), JSON.stringify(room), { ex: ROOM_TTL_SECONDS });
  }
  res.status(200).json({ ok: true });
}
