import { assertOriginAllowed, getClientIp, rateLimit } from '../../lib/security.js';
import { getRoom, saveRoom, publicParticipants } from '../../lib/party.js';

export default async function handler(req, res) {
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`party-state:${ip}`, 60, 60);
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

  const roomId = String(req.query.room || '').toLowerCase();
  if (!roomId) return res.status(400).json({ error: 'Missing room id.' });

  const room = await getRoom(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found or the party has ended.' });

  const token = String(req.query.token || req.body?.token || '');
  const isHost = token && room.hostToken === token;
  const isGuest = !!token && Object.values(room.guests || {}).some((g) => g.token === token);

  if (req.method === 'GET') {
    if (!isHost && !isGuest) return res.status(403).json({ error: 'Unauthorized.' });
    return res.status(200).json({
      mediaMeta: room.mediaMeta,
      lastState: room.lastState,
      participants: publicParticipants(room),
    });
  }

  if (req.method === 'POST') {
    if (!isHost) return res.status(403).json({ error: 'Only the host can do that.' });
    const state = req.body || {};
    delete state.token;
    room.lastState = state;
    room.updatedAt = Date.now();
    await saveRoom(roomId, room);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
