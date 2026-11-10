/**
 * VIDORA — WATCH PARTY: ROOM HELPERS
 * Lives under api/_lib/ (underscore prefix) so Vercel treats it as a plain
 * importable module instead of building it as its own serverless function.
 *
 * STORAGE LAYOUT
 * The room used to be ONE JSON blob that every request read, modified and
 * wrote back whole. With a host pushing state, guests reporting presence
 * every few seconds and people joining/leaving, those read-modify-write
 * cycles raced: a guest's presence write could land after the host's state
 * write and silently put the OLD state back, so guests missed play/pause/
 * seek commands at random. Each kind of data now has its own key, and each
 * has exactly one kind of writer:
 *
 *   party:<id>            core    – host token, password hash, media (host only)
 *   party:<id>:state      state   – the host's latest playback state (host only)
 *   party:<id>:guests     hash    – guestId -> { token, name, avatar, joinedAt }
 *   party:<id>:presence   hash    – 'host' | guestId -> { time, playing, updatedAt }
 */
import crypto from 'crypto';
import kv from './kv.js';

export const ROOM_TTL_SECONDS = 60 * 60 * 4;
export const ROOM_PREFIX = 'party:';

// Guests that haven't reported presence (or joined) in this long are
// considered gone (closed tab, lost connection) and are dropped on the
// next read. Generous on purpose: background tabs throttle timers down to
// roughly once a minute.
export const GUEST_STALE_MS = 5 * 60 * 1000;

// Avatars are small, resized-client-side JPEG data URLs (see
// VidoraProfile.fileToAvatar). This cap is generous headroom above what
// that resizing actually produces.
const MAX_AVATAR_LENGTH = 60000;
// Strict shape: a base64 raster image data URL and nothing else. The
// previous check only looked at the "data:image/" prefix, so a value like
//   data:image/x" onerror="...
// passed and was later interpolated into <img src="..."> on every other
// participant's screen.
const AVATAR_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function getRoomKey(roomId) {
  return `${ROOM_PREFIX}${String(roomId || '').toLowerCase()}`;
}
export const stateKey = (roomId) => `${getRoomKey(roomId)}:state`;
export const guestsKey = (roomId) => `${getRoomKey(roomId)}:guests`;
export const presenceKey = (roomId) => `${getRoomKey(roomId)}:presence`;

export function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

// Reads a value that may come back from KV as an already-parsed object
// (Upstash auto-deserializes JSON) or as the raw string we stored.
export function parse(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function cleanInt(v, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

// The host controls this object and every guest navigates to it, so it is
// validated to the exact shape the app produces — ids are TMDB-style
// integers, never free text that could end up inside a URL path.
export function cleanMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  if (meta.mediaType !== 'movie' && meta.mediaType !== 'tv') return null;
  const id = cleanInt(meta.id, 999999999999);
  if (id === null) return null;
  const out = {
    mediaType: meta.mediaType,
    id: String(id),
    title: String(meta.title || '').slice(0, 200),
    poster: typeof meta.poster === 'string' && /^https:\/\//i.test(meta.poster) && meta.poster.length <= 500 ? meta.poster : null,
  };
  if (meta.mediaType === 'tv') {
    const season = cleanInt(meta.season, 9999);
    const episode = cleanInt(meta.episode, 99999);
    if (season === null || episode === null) return null;
    out.season = String(season);
    out.episode = String(episode);
  }
  return out;
}

export function sanitizeAvatar(avatar) {
  if (typeof avatar !== 'string') return null;
  if (avatar.length > MAX_AVATAR_LENGTH) return null;
  return AVATAR_RE.test(avatar) ? avatar : null;
}

export function cleanName(name, fallback) {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20);
  return s || fallback;
}

// A participant's own last-reported playback position — separate from the
// host's authoritative state. One-way informational data.
const MAX_PRESENCE_SECONDS = 100000000;
export function sanitizePresence(time, playing) {
  const t = Number(time);
  if (!Number.isFinite(t) || t < 0 || t > MAX_PRESENCE_SECONDS) return null;
  return { time: t, playing: !!playing, updatedAt: Date.now() };
}

const STATE_EVENTS = new Set(['play', 'pause', 'seeked', 'ended', 'timeupdate']);
// Whitelists the fields of a host playback state. `at` is stamped by the
// SERVER so guests can work out how old a state is using one clock
// (the server's) instead of comparing two machines' clocks.
export function sanitizeState(body) {
  if (!body || typeof body !== 'object') return null;
  if (!STATE_EVENTS.has(body.event)) return null;
  const currentTime = Number(body.currentTime);
  if (!Number.isFinite(currentTime) || currentTime < 0 || currentTime > MAX_PRESENCE_SECONDS) return null;
  const duration = Number(body.duration);
  return {
    event: body.event,
    currentTime,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    // Explicit play/pause status. "seeked" says nothing about whether the
    // host is playing, and guessing it from the event name made guests
    // autoplay whenever a paused host scrubbed.
    playing: typeof body.playing === 'boolean' ? body.playing : (body.event !== 'pause' && body.event !== 'ended'),
    at: Date.now(),
  };
}

export async function getCore(roomId) {
  if (!roomId) return null;
  return parse(await kv.get(getRoomKey(roomId)));
}

export async function saveCore(roomId, core) {
  await kv.set(getRoomKey(roomId), JSON.stringify(core), { ex: ROOM_TTL_SECONDS });
}

// Slides the TTL of every key belonging to the room. Only host-originated
// activity calls this, so a room lives as long as its host is around.
export async function touchRoom(roomId) {
  await Promise.all([
    kv.expire(getRoomKey(roomId), ROOM_TTL_SECONDS),
    kv.expire(stateKey(roomId), ROOM_TTL_SECONDS),
    kv.expire(guestsKey(roomId), ROOM_TTL_SECONDS),
    kv.expire(presenceKey(roomId), ROOM_TTL_SECONDS),
  ]);
}

export async function deleteRoom(roomId) {
  await kv.del(getRoomKey(roomId), stateKey(roomId), guestsKey(roomId), presenceKey(roomId));
}

export async function getGuests(roomId) {
  const raw = await kv.hgetall(guestsKey(roomId));
  const out = {};
  for (const [id, v] of Object.entries(raw || {})) {
    const g = parse(v);
    if (g) out[id] = g;
  }
  return out;
}

export async function getPresence(roomId) {
  const raw = await kv.hgetall(presenceKey(roomId));
  const out = {};
  for (const [id, v] of Object.entries(raw || {})) {
    const p = parse(v);
    if (p) out[id] = p;
  }
  return out;
}

export async function getState(roomId) {
  return parse(await kv.get(stateKey(roomId)));
}

// Drops guests that have gone quiet and returns the survivors.
export async function pruneGuests(roomId, guests, presence) {
  const now = Date.now();
  const gone = [];
  for (const [id, g] of Object.entries(guests)) {
    const last = Math.max(g.joinedAt || 0, (presence[id] && presence[id].updatedAt) || 0);
    if (now - last > GUEST_STALE_MS) gone.push(id);
  }
  if (gone.length) {
    await Promise.all([kv.hdel(guestsKey(roomId), ...gone), kv.hdel(presenceKey(roomId), ...gone)]);
    gone.forEach((id) => { delete guests[id]; delete presence[id]; });
  }
  return guests;
}

export function findGuestByToken(guests, token) {
  if (!token) return null;
  for (const [id, g] of Object.entries(guests)) {
    if (g.token === token) return id;
  }
  return null;
}

// Constant-time token comparison.
export function tokensMatch(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function publicParticipants(core, guests, presence) {
  return [
    { id: 'host', name: core.hostName, host: true, avatar: core.hostAvatar || null, presence: presence.host || null },
    ...Object.entries(guests).map(([id, g]) => (
      { id, name: g.name, host: false, avatar: g.avatar || null, presence: presence[id] || null }
    )),
  ];
}
