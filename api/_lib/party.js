/**
 * VIDORA — WATCH PARTY: ROOM HELPERS
 * Lives under api/_lib/ (underscore prefix) so Vercel treats it as a plain
 * importable module instead of building it as its own serverless function.
 */
import crypto from 'crypto';
import kv from './kv.js';

export const ROOM_TTL_SECONDS = 60 * 60 * 4;
export const ROOM_PREFIX = 'party:';

export function getRoomKey(roomId) {
  return `${ROOM_PREFIX}${String(roomId || '').toLowerCase()}`;
}

export function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

export function cleanMeta(meta) {
  if (!meta) return null;
  return {
    mediaType: meta.mediaType,
    id: meta.id,
    title: meta.title,
    poster: meta.poster,
    season: meta.season,
    episode: meta.episode,
  };
}

export function publicParticipants(room) {
  return [
    { id: 'host', name: room.hostName, host: true },
    ...Object.entries(room.guests || {}).map(([id, g]) => ({ id, name: g.name, host: false })),
  ];
}

export async function getRoom(roomId) {
  if (!roomId) return null;
  const raw = await kv.get(getRoomKey(roomId));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function saveRoom(roomId, room) {
  await kv.set(getRoomKey(roomId), JSON.stringify(room), { ex: ROOM_TTL_SECONDS });
  return room;
}
