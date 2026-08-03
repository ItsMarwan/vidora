import crypto from 'crypto';
import kv from '../lib/kv.js';
import { assertOriginAllowed, getClientIp, rateLimit } from '../lib/security.js';
import { ROOM_TTL_SECONDS, cleanMeta, getRoomKey, hashPassword } from '../lib/party.js';

const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function genCode(len = 6) {
  return Array.from({ length: len }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const ip = getClientIp(req);
  const rl = await rateLimit(`party-create:${ip}`, 10, 60 * 10);
  if (!rl.allowed) return res.status(429).json({ error: 'Too many rooms created — try again later.' });

  const { name, password, mediaMeta } = req.body || {};
  if (!password || String(password).length < 3) {
    return res.status(400).json({ error: 'Choose a longer password.' });
  }

  let roomId = null;
  for (let i = 0; i < 6; i++) {
    const candidate = genCode();
    const exists = await kv.get(getRoomKey(candidate));
    if (!exists) { roomId = candidate; break; }
  }
  if (!roomId) return res.status(500).json({ error: 'Could not allocate a room — try again.' });

  const hostToken = crypto.randomBytes(24).toString('hex');
  const room = {
    hostToken,
    hostName: String(name || 'Host').slice(0, 20),
    passwordHash: hashPassword(password),
    mediaMeta: cleanMeta(mediaMeta),
    lastState: null,
    guests: {},
    updatedAt: Date.now(),
  };
  await kv.set(getRoomKey(roomId), JSON.stringify(room), { ex: ROOM_TTL_SECONDS });

  res.status(200).json({ roomId, hostToken });
}
