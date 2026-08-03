import crypto from 'crypto';
import kv from './_lib/kv.js';
import { assertOriginAllowed, getClientIp, rateLimit } from './_lib/security.js';
import {
  ROOM_TTL_SECONDS,
  cleanMeta,
  getRoomKey,
  hashPassword,
  publicParticipants,
  getRoom,
  saveRoom,
} from './_lib/party.js';

/**
 * VIDORA — WATCH PARTY (server-relayed, single flat endpoint)
 * -----------------------------------------------------------
 * No peer-to-peer, no WebRTC, nobody's IP ever reaches anybody else.
 * Every action goes through THIS endpoint on your own Vercel deployment,
 * backed by KV — the server owns the password check, hands back
 * per-participant tokens, and is the sole source of truth for room state.
 *
 * One flat file (no [...catch-all] segment) — the action is carried in
 * ?action=... (GET) or { action } in the JSON body (POST), never in the
 * URL path, so there's no dynamic route pattern for Vercel to resolve.
 * -----------------------------------------------------------
 */

function readRoomId(req) {
  const fromQuery = req.query?.roomId;
  const fromBody = req.body?.roomId;
  return String(fromQuery || fromBody || '').toLowerCase();
}

function readToken(req) {
  return String(req.query?.token || req.body?.token || '');
}

function readAction(req) {
  return String(req.query?.action || req.body?.action || '');
}

export default async function handler(req, res) {
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  const action = readAction(req);
  const ip = getClientIp(req);

  // ---------------- create ----------------
  if (action === 'create') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const rl = await rateLimit(`party-create:${ip}`, 10, 60 * 10);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many rooms created — try again later.' });

    const { name, password, mediaMeta } = req.body || {};
    if (!password || String(password).length < 3) {
      return res.status(400).json({ error: 'Choose a longer password.' });
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

    return res.status(200).json({ roomId, hostToken });
  }

  // ---------------- join ----------------
  if (action === 'join') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const rl = await rateLimit(`party-join:${ip}`, 20, 60 * 5);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many attempts — slow down.' });

    const { roomId, password, name } = req.body || {};
    if (!roomId || !password) return res.status(400).json({ error: 'Missing room code or password.' });

    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found or the party has ended.' });
    if (hashPassword(password) !== room.passwordHash) {
      return res.status(403).json({ error: 'Wrong password.' });
    }

    const guestId = crypto.randomBytes(4).toString('hex');
    const guestToken = crypto.randomBytes(24).toString('hex');
    room.guests[guestId] = { token: guestToken, name: String(name || 'Guest').slice(0, 20) };
    room.updatedAt = Date.now();
    await saveRoom(roomId, room);

    return res.status(200).json({
      guestId,
      guestToken,
      mediaMeta: room.mediaMeta,
      lastState: room.lastState,
      participants: publicParticipants(room),
    });
  }

  // ---------------- leave ----------------
  if (action === 'leave') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const rl = await rateLimit(`party-leave:${ip}`, 60, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

    const roomId = readRoomId(req);
    const room = roomId ? await getRoom(roomId) : null;
    if (!room) return res.status(200).json({ ok: true });

    const token = readToken(req);
    if (token === room.hostToken) {
      await kv.del(getRoomKey(roomId));
      return res.status(200).json({ ok: true, ended: true });
    }

    const guestEntry = Object.entries(room.guests || {}).find(([, g]) => g.token === token);
    if (guestEntry) {
      delete room.guests[guestEntry[0]];
      room.updatedAt = Date.now();
      await saveRoom(roomId, room);
    }
    return res.status(200).json({ ok: true });
  }

  // ---------------- media (host changes what's playing) ----------------
  if (action === 'media') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const rl = await rateLimit(`party-media:${ip}`, 60, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

    const roomId = readRoomId(req);
    const room = roomId ? await getRoom(roomId) : null;
    if (!room) return res.status(404).json({ error: 'Room not found or the party has ended.' });

    const token = readToken(req);
    if (token !== room.hostToken) return res.status(403).json({ error: 'Only the host can do that.' });

    room.mediaMeta = cleanMeta(req.body?.mediaMeta);
    room.lastState = null;
    room.updatedAt = Date.now();
    await saveRoom(roomId, room);
    return res.status(200).json({ ok: true });
  }

  // ---------------- state (guests poll via GET, host pushes via POST) ----------------
  if (action === 'state') {
    const rl = await rateLimit(`party-state:${ip}`, 60, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

    const roomId = readRoomId(req);
    if (!roomId) return res.status(400).json({ error: 'Missing room id.' });

    const room = await getRoom(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found or the party has ended.' });

    const token = readToken(req);
    const isHost = !!token && room.hostToken === token;
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
      const state = { ...(req.body || {}) };
      delete state.token;
      delete state.action;
      delete state.roomId;
      room.lastState = state;
      room.updatedAt = Date.now();
      await saveRoom(roomId, room);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(400).json({ error: 'Unknown or missing action' });
}
