/**
 * VIDORA — WATCH PARTY: ROOM HELPERS
 * Lives under api/_lib/ (underscore prefix) so Vercel treats it as a plain
 * importable module instead of building it as its own serverless function.
 */
import crypto from 'crypto';
import kv from './kv.js';

export const ROOM_TTL_SECONDS = 60 * 60 * 4;
export const ROOM_PREFIX = 'party:';

// Avatars are small, resized-client-side JPEG data URLs (see
// VidoraProfile.fileToAvatar). This cap is generous headroom above what
// that resizing actually produces — anything bigger is rejected rather
// than written to KV, so a room can never balloon in size because of a
// photo.
const MAX_AVATAR_LENGTH = 60000;

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

// Only ever accepts a data: image URL under the size cap — anything else
// (a remote URL, arbitrary text, an oversized string) is dropped so a
// malformed or hostile `avatar` field never reaches storage or gets
// reflected back to other participants.
export function sanitizeAvatar(avatar) {
  if (typeof avatar !== 'string') return null;
  if (!avatar.startsWith('data:image/')) return null;
  if (avatar.length > MAX_AVATAR_LENGTH) return null;
  return avatar;
}

export function publicParticipants(room) {
  return [
    { id: 'host', name: room.hostName, host: true, avatar: room.hostAvatar || null },
    ...Object.entries(room.guests || {}).map(([id, g]) => ({ id, name: g.name, host: false, avatar: g.avatar || null })),
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
