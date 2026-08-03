import { assertOriginAllowed, getClientIp, rateLimit } from '../../lib/security.js';
import { cleanMeta, getRoom, saveRoom } from '../../lib/party.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`party-media:${ip}`, 60, 60);
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

  const roomId = String(req.query.room || '').toLowerCase();
  if (!roomId) return res.status(400).json({ error: 'Missing room id.' });

  const room = await getRoom(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found or the party has ended.' });

  const { token, mediaMeta } = req.body || {};
  if (token !== room.hostToken) return res.status(403).json({ error: 'Only the host can do that.' });

  room.mediaMeta = cleanMeta(mediaMeta);
  room.lastState = null;
  room.updatedAt = Date.now();
  await saveRoom(roomId, room);
  res.status(200).json({ ok: true });
}
