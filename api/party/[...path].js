import crypto from 'crypto';
import kv from '../lib/kv.js';
import { assertOriginAllowed, getClientIp, rateLimit } from '../lib/security.js';
import {
  ROOM_TTL_SECONDS,
  cleanMeta,
  getRoomKey,
  hashPassword,
  publicParticipants,
  getRoom,
  saveRoom,
} from '../lib/party.js';

function getPathSegments(req) {
  if (req.query && req.query.path) {
    return Array.isArray(req.query.path) ? req.query.path : [req.query.path];
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.pathname.split('/').filter(Boolean).slice(2);
  } catch {
    return [];
  }
}

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (!assertOriginAllowed(req)) return sendJson(res, 403, { error: 'Forbidden origin' });

  const segments = getPathSegments(req);
  const action = segments[0];

  if (action === 'create') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

    const ip = getClientIp(req);
    const rl = await rateLimit(`party-create:${ip}`, 10, 60 * 10);
    if (!rl.allowed) return sendJson(res, 429, { error: 'Too many rooms created — try again later.' });

    const { name, password, mediaMeta } = req.body || {};
    if (!password || String(password).length < 3) {
      return sendJson(res, 400, { error: 'Choose a longer password.' });
    }

    const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
    const genCode = (len = 6) =>
      Array.from({ length: len }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

    let roomId = null;
    for (let i = 0; i < 6; i += 1) {
      const candidate = genCode();
      const exists = await kv.get(getRoomKey(candidate));
      if (!exists) { roomId = candidate; break; }
    }
    if (!roomId) return sendJson(res, 500, { error: 'Could not allocate a room — try again.' });

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

    return sendJson(res, 200, { roomId, hostToken });
  }

  if (action === 'join') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });

    const ip = getClientIp(req);
    const rl = await rateLimit(`party-join:${ip}`, 20, 60 * 5);
    if (!rl.allowed) return sendJson(res, 429, { error: 'Too many attempts — slow down.' });

    const { roomId, password, name } = req.body || {};
    if (!roomId || !password) return sendJson(res, 400, { error: 'Missing room code or password.' });

    const room = await getRoom(roomId);
    if (!room) return sendJson(res, 404, { error: 'Room not found or the party has ended.' });
    if (hashPassword(password) !== room.passwordHash) {
      return sendJson(res, 403, { error: 'Wrong password.' });
    }

    const guestId = crypto.randomBytes(4).toString('hex');
    const guestToken = crypto.randomBytes(24).toString('hex');
    room.guests[guestId] = { token: guestToken, name: String(name || 'Guest').slice(0, 20) };
    room.updatedAt = Date.now();
    await saveRoom(roomId, room);

    return sendJson(res, 200, {
      guestId,
      guestToken,
      mediaMeta: room.mediaMeta,
      lastState: room.lastState,
      participants: publicParticipants(room),
    });
  }

  if (segments.length !== 2) return sendJson(res, 404, { error: 'Not found' });

  const roomId = String(segments[0] || '').toLowerCase();
  const verb = segments[1];
  const room = await getRoom(roomId);

  if (verb === 'leave') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const ip = getClientIp(req);
    const rl = await rateLimit(`party-leave:${ip}`, 60, 60);
    if (!rl.allowed) return sendJson(res, 429, { error: 'Too many requests' });
    if (!room) return sendJson(res, 200, { ok: true });

    const { token } = req.body || {};
    if (token === room.hostToken) {
      await kv.del(getRoomKey(roomId));
      return sendJson(res, 200, { ok: true, ended: true });
    }

    const guestEntry = Object.entries(room.guests || {}).find(([, g]) => g.token === token);
    if (guestEntry) {
      delete room.guests[guestEntry[0]];
      room.updatedAt = Date.now();
      await saveRoom(roomId, room);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (verb === 'media') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const ip = getClientIp(req);
    const rl = await rateLimit(`party-media:${ip}`, 60, 60);
    if (!rl.allowed) return sendJson(res, 429, { error: 'Too many requests' });
    if (!room) return sendJson(res, 404, { error: 'Room not found or the party has ended.' });

    const { token, mediaMeta } = req.body || {};
    if (token !== room.hostToken) return sendJson(res, 403, { error: 'Only the host can do that.' });

    room.mediaMeta = cleanMeta(mediaMeta);
    room.lastState = null;
    room.updatedAt = Date.now();
    await saveRoom(roomId, room);
    return sendJson(res, 200, { ok: true });
  }

  if (verb === 'state') {
    const ip = getClientIp(req);
    const rl = await rateLimit(`party-state:${ip}`, 60, 60);
    if (!rl.allowed) return sendJson(res, 429, { error: 'Too many requests' });
    if (!room) return sendJson(res, 404, { error: 'Room not found or the party has ended.' });

    const token = String(req.query?.token || req.body?.token || '');
    const isHost = token && room.hostToken === token;
    const isGuest = !!token && Object.values(room.guests || {}).some((g) => g.token === token);

    if (req.method === 'GET') {
      if (!isHost && !isGuest) return sendJson(res, 403, { error: 'Unauthorized.' });
      return sendJson(res, 200, {
        mediaMeta: room.mediaMeta,
        lastState: room.lastState,
        participants: publicParticipants(room),
      });
    }

    if (req.method === 'POST') {
      if (!isHost) return sendJson(res, 403, { error: 'Only the host can do that.' });
      const state = req.body || {};
      delete state.token;
      room.lastState = state;
      room.updatedAt = Date.now();
      await saveRoom(roomId, room);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  return sendJson(res, 404, { error: 'Not found' });
}
