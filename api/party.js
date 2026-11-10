import crypto from 'crypto';
import kv from './_lib/kv.js';
import { assertOriginAllowed, getClientIp, rateLimit } from './_lib/security.js';
import {
  ROOM_TTL_SECONDS,
  getRoomKey,
  stateKey,
  guestsKey,
  presenceKey,
  hashPassword,
  cleanMeta,
  cleanName,
  sanitizeAvatar,
  sanitizePresence,
  sanitizeState,
  getCore,
  saveCore,
  touchRoom,
  deleteRoom,
  getGuests,
  getPresence,
  getState,
  pruneGuests,
  findGuestByToken,
  tokensMatch,
  publicParticipants,
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
 *
 * Actions: create · join · leave · media · presence · state (GET = poll,
 * POST = host pushes playback state).
 *
 * The player itself is irrelevant to this API: the host just reports
 * { event, currentTime, duration, playing } and guests get it back. That
 * is what lets the same room drive an embed iframe or a native <video>
 * player (the Vidora media player / extension) interchangeably.
 *
 * Rate limits for polling/presence are keyed by the caller's secret token
 * rather than by IP: everyone behind one home router or office NAT shares
 * an IP, and the old per-IP budget made a second person in the same
 * household get 429s mid-movie.
 * -----------------------------------------------------------
 */

function readRoomId(req) {
  const fromQuery = req.query?.roomId;
  const fromBody = req.body?.roomId;
  return String(fromQuery || fromBody || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
}

function readToken(req) {
  return String(req.query?.token || req.body?.token || '').slice(0, 128);
}

function readAction(req) {
  return String(req.query?.action || req.body?.action || '');
}

const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function genCode(len = 6) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

// Resolves who the caller is within a room: { role: 'host' } | { role: 'guest', guestId } | null
function identify(core, guests, token) {
  if (tokensMatch(token, core.hostToken)) return { role: 'host' };
  const guestId = findGuestByToken(guests, token);
  return guestId ? { role: 'guest', guestId } : null;
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

    const { name, password, mediaMeta, avatar } = req.body || {};
    if (!password || String(password).length < 3 || String(password).length > 64) {
      return res.status(400).json({ error: 'Choose a password between 3 and 64 characters.' });
    }
    const meta = cleanMeta(mediaMeta);
    if (!meta) return res.status(400).json({ error: 'Invalid media.' });

    let roomId = null;
    for (let i = 0; i < 6; i += 1) {
      const candidate = genCode();
      if (!(await kv.get(getRoomKey(candidate)))) { roomId = candidate; break; }
    }
    if (!roomId) return res.status(500).json({ error: 'Could not allocate a room — try again.' });

    const hostToken = crypto.randomBytes(24).toString('hex');
    await saveCore(roomId, {
      hostToken,
      hostName: cleanName(name, 'Host'),
      hostAvatar: sanitizeAvatar(avatar),
      passwordHash: hashPassword(password),
      mediaMeta: meta,
      createdAt: Date.now(),
    });

    return res.status(200).json({ roomId, hostToken, serverNow: Date.now() });
  }

  // ---------------- join ----------------
  if (action === 'join') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const rl = await rateLimit(`party-join:${ip}`, 20, 60 * 5);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many attempts — slow down.' });

    const { password, name, avatar } = req.body || {};
    const roomId = readRoomId(req);
    if (!roomId || !password) return res.status(400).json({ error: 'Missing room code or password.' });

    const core = await getCore(roomId);
    if (!core) return res.status(404).json({ error: 'Room not found or the party has ended.' });
    if (!tokensMatch(hashPassword(password), core.passwordHash)) {
      return res.status(403).json({ error: 'Wrong password.' });
    }

    const guestId = crypto.randomBytes(4).toString('hex');
    const guestToken = crypto.randomBytes(24).toString('hex');
    // A single-field hash write: two people joining at the same moment can
    // no longer overwrite each other the way a whole-room save could.
    await kv.hset(guestsKey(roomId), {
      [guestId]: JSON.stringify({
        token: guestToken,
        name: cleanName(name, 'Guest'),
        avatar: sanitizeAvatar(avatar),
        joinedAt: Date.now(),
      }),
    });
    await kv.expire(guestsKey(roomId), ROOM_TTL_SECONDS);

    const [guests, presence, lastState] = await Promise.all([getGuests(roomId), getPresence(roomId), getState(roomId)]);
    return res.status(200).json({
      guestId,
      guestToken,
      mediaMeta: core.mediaMeta,
      lastState,
      participants: publicParticipants(core, guests, presence),
      serverNow: Date.now(),
    });
  }

  // ---------------- leave ----------------
  if (action === 'leave') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const rl = await rateLimit(`party-leave:${ip}`, 60, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

    const roomId = readRoomId(req);
    const core = roomId ? await getCore(roomId) : null;
    if (!core) return res.status(200).json({ ok: true });

    const token = readToken(req);
    if (tokensMatch(token, core.hostToken)) {
      await deleteRoom(roomId);
      return res.status(200).json({ ok: true, ended: true });
    }

    const guests = await getGuests(roomId);
    const guestId = findGuestByToken(guests, token);
    if (guestId) {
      await Promise.all([kv.hdel(guestsKey(roomId), guestId), kv.hdel(presenceKey(roomId), guestId)]);
    }
    return res.status(200).json({ ok: true });
  }

  // ---------------- media (host changes what's playing) ----------------
  if (action === 'media') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const token = readToken(req);
    const rl = await rateLimit(`party-media:${token || ip}`, 60, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

    const roomId = readRoomId(req);
    const core = roomId ? await getCore(roomId) : null;
    if (!core) return res.status(404).json({ error: 'Room not found or the party has ended.' });
    if (!tokensMatch(token, core.hostToken)) return res.status(403).json({ error: 'Only the host can do that.' });

    const meta = cleanMeta(req.body?.mediaMeta);
    if (!meta) return res.status(400).json({ error: 'Invalid media.' });

    core.mediaMeta = meta;
    await saveCore(roomId, core);
    await kv.del(stateKey(roomId)); // the previous title's position means nothing for the new one
    await touchRoom(roomId);
    return res.status(200).json({ ok: true });
  }

  // ---------------- presence (anyone reports their OWN live position) ----------------
  // Purely informational — shown next to each name in the party list, and
  // doubles as the keep-alive that stops a guest from being pruned. Never
  // touches the host's playback state.
  if (action === 'presence') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const token = readToken(req);
    const rl = await rateLimit(`party-presence:${token || ip}`, 60, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

    const roomId = readRoomId(req);
    const core = roomId ? await getCore(roomId) : null;
    if (!core) return res.status(404).json({ error: 'Room not found or the party has ended.' });

    const presence = sanitizePresence(req.body?.time, req.body?.playing);
    if (!presence) return res.status(400).json({ error: 'Invalid presence data.' });

    let who;
    if (tokensMatch(token, core.hostToken)) {
      who = 'host';
      await touchRoom(roomId);
    } else {
      const guestId = findGuestByToken(await getGuests(roomId), token);
      if (!guestId) return res.status(403).json({ error: 'Unauthorized.' });
      who = guestId;
    }
    await kv.hset(presenceKey(roomId), { [who]: JSON.stringify(presence) });
    return res.status(200).json({ ok: true });
  }

  // ---------------- state (everyone polls via GET, host pushes via POST) ----------------
  if (action === 'state') {
    const token = readToken(req);
    const rlIp = await rateLimit(`party-state-ip:${ip}`, 600, 60);
    if (!rlIp.allowed) return res.status(429).json({ error: 'Too many requests' });
    const rl = await rateLimit(`party-state:${token || ip}`, 150, 60);
    if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' });

    const roomId = readRoomId(req);
    if (!roomId) return res.status(400).json({ error: 'Missing room id.' });

    const core = await getCore(roomId);
    if (!core) return res.status(404).json({ error: 'Room not found or the party has ended.' });

    if (req.method === 'GET') {
      const [guestsRaw, presence, lastState] = await Promise.all([getGuests(roomId), getPresence(roomId), getState(roomId)]);
      const me = identify(core, guestsRaw, token);
      if (!me) return res.status(403).json({ error: 'Unauthorized.' });
      const guests = await pruneGuests(roomId, guestsRaw, presence);
      return res.status(200).json({
        role: me.role,
        mediaMeta: core.mediaMeta,
        lastState,
        participants: publicParticipants(core, guests, presence),
        serverNow: Date.now(),
      });
    }

    if (req.method === 'POST') {
      if (!tokensMatch(token, core.hostToken)) return res.status(403).json({ error: 'Only the host can do that.' });
      const state = sanitizeState(req.body);
      if (!state) return res.status(400).json({ error: 'Invalid state.' });
      await kv.set(stateKey(roomId), JSON.stringify(state), { ex: ROOM_TTL_SECONDS });
      await touchRoom(roomId);
      return res.status(200).json({ ok: true, at: state.at });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(400).json({ error: 'Unknown or missing action' });
}
