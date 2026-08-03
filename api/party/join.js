import crypto from 'crypto';
import kv from '../lib/kv.js';
import { assertOriginAllowed, getClientIp, rateLimit } from '../lib/security.js';
import { ROOM_TTL_SECONDS, getRoomKey, hashPassword, publicParticipants } from '../lib/party.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`party-join:${ip}`, 20, 60 * 5);
  if (!rl.allowed) return res.status(429).json({ error: 'Too many attempts — slow down.' });

  const { roomId, password, name } = req.body || {};
  if (!roomId || !password) return res.status(400).json({ error: 'Missing room code or password.' });

  const raw = await kv.get(getRoomKey(roomId));
  if (!raw) return res.status(404).json({ error: 'Room not found or the party has ended.' });
  const room = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (hashPassword(password) !== room.passwordHash) {
    return res.status(403).json({ error: 'Wrong password.' });
  }

  const guestId = crypto.randomBytes(4).toString('hex');
  const guestToken = crypto.randomBytes(24).toString('hex');
  room.guests[guestId] = { token: guestToken, name: String(name || 'Guest').slice(0, 20) };
  room.updatedAt = Date.now();
  await kv.set(getRoomKey(roomId), JSON.stringify(room), { ex: ROOM_TTL_SECONDS });

  res.status(200).json({
    guestId,
    guestToken,
    mediaMeta: room.mediaMeta,
    lastState: room.lastState,
    participants: publicParticipants(room),
  });
}
