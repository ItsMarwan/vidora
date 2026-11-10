/**
 * VIDORA — WATCH PARTY (server-relayed)
 * -----------------------------------------------------------
 * No PeerJS, no WebRTC, no direct connection between participants'
 * browsers at all. Every action goes through the single /api/party
 * endpoint on your own Vercel deployment, backed by KV:
 *   - createRoom / joinRoom hit the server, which owns the password check
 *     and hands back a per-participant token.
 *   - The host pushes its playback state to the server.
 *   - Everyone polls the server for the latest state, media and people.
 *
 * THIS MODULE KNOWS NOTHING ABOUT THE PLAYER. It consumes the player-event
 * stream from VidoraPlayer (which is fed by embed iframes AND by the native
 * Vidora media player alike) and produces a plain description of "where the
 * host is": { time, playing }. How a guest's player is then brought to that
 * point is js/stage.js's job — a native player is simply told, an embed
 * iframe is reloaded at the right position. That split is what lets one
 * room drive either kind of player.
 *
 * Host state messages carry an explicit `playing` boolean and the server
 * stamps each with its own clock (`at`). A guest works out how old a state
 * is from the server's clock alone, then keeps projecting the host's
 * position forward locally while it's playing — so joining mid-movie, or a
 * slow poll, still lands on the right second instead of wherever the host
 * happened to press play minutes ago.
 *
 * The session (room + token) is kept in sessionStorage, so refreshing the
 * tab rejoins the party instead of silently ending it.
 * -----------------------------------------------------------
 */

const VidoraParty = (() => {
  const listeners = { participants: [], state: [], media: [], disconnect: [], session: [] };
  function on(evt, cb) {
    if (!listeners[evt]) listeners[evt] = [];
    listeners[evt].push(cb);
    return () => off(evt, cb);
  }
  function off(evt, cb) {
    if (!listeners[evt]) return;
    listeners[evt] = listeners[evt].filter((fn) => fn !== cb);
  }
  function emit(evt, payload) {
    (listeners[evt] || []).forEach((cb) => {
      try { cb(payload); } catch (err) { console.error("[Watch Party] listener error:", err); }
    });
  }

  const SESSION_KEY = "vidora_party_session";
  const GUEST_POLL_MS = 1800;
  const HOST_POLL_MS = 4000;
  const MAX_POLL_FAILURES = 8;     // consecutive transient failures before we give up
  const HEARTBEAT_MS = 15000;      // host re-anchors guests this often while playing
  const PRESENCE_MS = 15000;       // keep-alive + "where am I" ping
  const MAX_PROJECT_MS = 90000;    // never project a stale "playing" state further than this

  let role = null; // 'host' | 'guest' | null
  let roomId = null, myToken = null, myName = null, myPassword = null, myAvatar = null;
  let mediaMeta = null, lastState = null, participants = [];

  // ---------------- helpers ----------------

  function cleanMeta(meta) {
    if (!meta) return null;
    const out = { mediaType: meta.mediaType, id: String(meta.id), title: meta.title, poster: meta.poster };
    if (meta.mediaType === "tv") { out.season = String(meta.season); out.episode = String(meta.episode); }
    return out;
  }

  // NOTE: VidoraProfile is declared as a top-level `const` in profile.js,
  // loaded as a plain <script> — a valid global binding, but NEVER a
  // property of `window`, so it must be checked as a bare identifier.
  function resolveIdentity(explicitName) {
    const profile = typeof VidoraProfile !== "undefined" && VidoraProfile.getProfile();
    const name = (explicitName && explicitName.trim()) || (profile && profile.name) || null;
    const avatar = (profile && profile.image) || null;
    return { name, avatar };
  }

  // Single flat endpoint. `action` goes in the query string for GET
  // requests and in the JSON body for POST requests.
  async function api(action, { method = "GET", query = null, body = null } = {}) {
    let url = "/api/party";
    let fetchBody;
    if (method === "GET") {
      const params = new URLSearchParams({ action, ...(query || {}) });
      url += `?${params.toString()}`;
    } else {
      fetchBody = JSON.stringify({ action, ...(body || {}) });
    }
    const res = await fetch(url, {
      method,
      headers: fetchBody ? { "Content-Type": "application/json" } : undefined,
      body: fetchBody,
    });
    let data = null;
    try { data = await res.json(); } catch { /* no/invalid body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Tags a server state with how stale it already was when it arrived
  // (measured entirely on the SERVER's clock) and when we received it
  // (our own clock), which is all that's needed to project it forward.
  function annotate(state, serverNow) {
    if (!state) return null;
    const staleMs = typeof serverNow === "number" && typeof state.at === "number"
      ? Math.max(0, serverNow - state.at) : 0;
    return { ...state, staleMs, receivedAt: Date.now() };
  }

  // Where the host is RIGHT NOW, according to the last state received.
  function getHostPosition() {
    const s = lastState;
    if (!s) return null;
    const ended = s.event === "ended";
    const playing = !ended && (typeof s.playing === "boolean" ? s.playing : s.event !== "pause");
    let time = s.currentTime || 0;
    if (playing) time += (Math.min(s.staleMs || 0, MAX_PROJECT_MS) + (Date.now() - s.receivedAt)) / 1000;
    return { time, playing, ended, event: s.event, duration: s.duration || 0 };
  }

  // ---------------- session persistence ----------------
  function saveSession() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        role, roomId, token: myToken, name: myName, avatar: myAvatar,
        password: role === "host" ? myPassword : null,
      }));
    } catch { /* storage unavailable */ }
  }
  function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } }
  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
  }

  // ---------------- polling ----------------
  // A chain of timeouts, not setInterval: with setInterval a slow response
  // let the next poll start before the previous one finished, and the two
  // answers could be applied out of order (older state overwriting newer).
  let pollTimer = null;
  let pollGen = 0;
  let failures = 0;

  function stopPolling() {
    pollGen += 1;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  function applyPoll(data) {
    const participantsChanged = JSON.stringify(data.participants) !== JSON.stringify(participants);
    participants = data.participants || [];
    if (participantsChanged) emit("participants", participants);

    if (role !== "guest") return; // the host is authoritative for its own media/state

    const mediaChanged = !!data.mediaMeta && !sameMedia(mediaMeta, data.mediaMeta);
    const raw = data.lastState || null;
    const stateChanged = JSON.stringify(raw) !== JSON.stringify(lastStateRaw);
    if (stateChanged) { lastStateRaw = raw; lastState = annotate(raw, data.serverNow); }

    if (mediaChanged) {
      // New title: hand over to the new watch page, which will pick up the
      // (already stored) state when it mounts. Emitting "state" here would
      // apply the new title's position to the OLD page's player.
      mediaMeta = data.mediaMeta;
      emit("media", mediaMeta);
      return;
    }
    if (stateChanged && lastState) emit("state", lastState);
  }
  let lastStateRaw = null;

  function sameMedia(a, b) {
    return !!a && !!b && a.mediaType === b.mediaType && String(a.id) === String(b.id) &&
      String(a.season ?? "") === String(b.season ?? "") && String(a.episode ?? "") === String(b.episode ?? "");
  }

  function fatal(message) {
    stopPolling();
    clearSession();
    emit("disconnect", message || "Lost connection to the party.");
  }

  function baseDelay() { return role === "host" ? HOST_POLL_MS : GUEST_POLL_MS; }

  function schedulePoll(gen, delay) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => tick(gen), delay);
  }

  async function tick(gen) {
    if (gen !== pollGen || !roomId || !myToken) return;
    try {
      const data = await api("state", { query: { roomId, token: myToken } });
      if (gen !== pollGen) return; // left/rejoined while this was in flight
      failures = 0;
      applyPoll(data);
      schedulePoll(gen, baseDelay());
    } catch (err) {
      if (gen !== pollGen) return;
      // 404/403 = the room is gone or we were removed: that's final.
      // Anything else (429, 5xx, a network blip) is transient — one hiccup
      // used to drop the whole party. Back off and keep trying.
      if (err.status === 404 || err.status === 403) { fatal(err.message); return; }
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) { fatal("Lost connection to the party."); return; }
      schedulePoll(gen, Math.min(15000, baseDelay() * 2 ** failures));
    }
  }

  function startPolling() {
    stopPolling();
    failures = 0;
    schedulePoll(pollGen, baseDelay());
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && roomId && myToken && pollTimer) {
      schedulePoll(pollGen, 0); // catch up immediately instead of waiting out a throttled timer
    }
  });

  // ---------------- room lifecycle ----------------
  async function createRoom(meta, password, hostName) {
    leaveRoom();
    const { name, avatar } = resolveIdentity(hostName);
    const data = await api("create", { method: "POST", body: { name: name || "Host", password, mediaMeta: cleanMeta(meta), avatar } });
    role = "host"; roomId = data.roomId; myToken = data.hostToken;
    myName = (name || "Host").slice(0, 20); myPassword = password; myAvatar = avatar;
    mediaMeta = cleanMeta(meta); lastState = null; lastStateRaw = null;
    participants = [{ id: "host", name: myName, host: true, avatar: myAvatar }];
    resetHostSync(true);
    saveSession();
    emit("participants", participants);
    startPolling();
    startPresence();
    emit("session", "created");
    primeFromLive();
    return roomId;
  }

  async function joinRoom(code, password, name) {
    leaveRoom();
    const identity = resolveIdentity(name);
    const roomCode = String(code).toLowerCase();
    const data = await api("join", { method: "POST", body: { roomId: roomCode, password, name: identity.name || "Guest", avatar: identity.avatar } });
    role = "guest"; roomId = roomCode; myToken = data.guestToken;
    myName = (identity.name || "Guest").slice(0, 20); myAvatar = identity.avatar;
    mediaMeta = data.mediaMeta; participants = data.participants || [];
    lastStateRaw = data.lastState || null; lastState = annotate(lastStateRaw, data.serverNow);
    saveSession();
    emit("participants", participants);
    startPolling();
    startPresence();
    emit("session", "joined");
    return mediaMeta;
  }

  // Rejoins a party after a page refresh using the token kept in
  // sessionStorage (the host's refresh used to end the party for everyone).
  async function resume() {
    if (role) return true;
    const s = readSession();
    if (!s || !s.roomId || !s.token) return false;
    try {
      const data = await api("state", { query: { roomId: s.roomId, token: s.token } });
      if (role) return true; // something else (a fresh create/join) won the race
      role = data.role === "host" ? "host" : "guest";
      roomId = s.roomId; myToken = s.token; myName = s.name; myAvatar = s.avatar || null;
      myPassword = role === "host" ? s.password || null : null;
      mediaMeta = data.mediaMeta; participants = data.participants || [];
      lastStateRaw = data.lastState || null;
      lastState = role === "guest" ? annotate(lastStateRaw, data.serverNow) : null;
      if (role === "host") resetHostSync(true);
      saveSession();
      emit("participants", participants);
      startPolling();
      startPresence();
      emit("session", "resumed");
      return true;
    } catch (err) {
      if (err.status === 404 || err.status === 403) clearSession();
      return false;
    }
  }

  function leaveRoom() {
    stopPolling();
    stopPresence();
    resetHostSync(false);
    if (roomId && myToken) {
      // Best-effort notice so the server (and everyone else) finds out
      // immediately. Only ever sent on an explicit leave/end — NOT on
      // page unload, because a refresh would otherwise end the party.
      try {
        const payload = new Blob(
          [JSON.stringify({ action: "leave", roomId, token: myToken })],
          { type: "application/json" },
        );
        if (navigator.sendBeacon) navigator.sendBeacon("/api/party", payload);
      } catch (err) { /* best effort only */ }
    }
    const hadRoom = !!role;
    role = null; roomId = null; myToken = null; myName = null; myPassword = null; myAvatar = null;
    mediaMeta = null; lastState = null; lastStateRaw = null; participants = [];
    clearSession();
    if (hadRoom) emit("session", "left");
  }

  async function updateMedia(meta) {
    if (role !== "host") return;
    mediaMeta = cleanMeta(meta);
    resetHostSync(true);
    try {
      await api("media", { method: "POST", body: { roomId, token: myToken, mediaMeta } });
    } catch (err) {
      console.warn("[Watch Party] failed to update media:", err);
      if (err.status === 404 || err.status === 403) fatal(err.message);
    }
  }

  // ---------------- host: pushing playback state ----------------
  // Pushes are serialized and coalesced: only the LATEST state matters to
  // the server, and two requests in flight at once could land out of order
  // (a "play" overtaking the "pause" that was sent before it).
  let pushing = false;
  let pendingPush = null;

  async function drainPushes() {
    if (pushing) return;
    pushing = true;
    try {
      while (pendingPush && role === "host") {
        const s = pendingPush;
        pendingPush = null;
        try {
          await api("state", { method: "POST", body: { roomId, token: myToken, ...s } });
        } catch (err) {
          console.warn("[Watch Party] failed to push state:", err);
          if (err.status === 404 || err.status === 403) { fatal(err.message); return; }
        }
      }
    } finally {
      pushing = false;
    }
  }

  function broadcastState(state) {
    if (role !== "host") return;
    pendingPush = state;
    drainPushes();
  }

  // Host-side event debouncing. A scrub-drag fires several "seeked" events,
  // and a pause immediately followed by a play is usually a seek in
  // disguise; both are collapsed so guests see ONE command, not a burst.
  const PAUSE_GRACE_MS = 550;
  const SEEK_GRACE_MS = 500;
  let hostPlaying = null;      // null = not known yet
  let needsPrime = false;      // first event after (re)creating/resuming/changing media pushes the current state
  let pendingPauseTimer = null;
  let pendingSeekTimer = null;
  let lastBroadcast = 0;

  function resetHostSync(prime) {
    clearTimeout(pendingPauseTimer); pendingPauseTimer = null;
    clearTimeout(pendingSeekTimer); pendingSeekTimer = null;
    hostPlaying = null;
    needsPrime = !!prime;
    lastBroadcast = 0;
    pendingPush = null;
  }

  function send(event, e, playing) {
    lastBroadcast = Date.now();
    needsPrime = false;
    broadcastState({ event, currentTime: e.currentTime, duration: e.duration || 0, playing });
  }

  // When a room is created while a video is already playing there will be
  // no "play" event to announce it — without this, anyone joining got no
  // state at all and sat on a stopped screen.
  function primeFromLive() {
    if (role !== "host" || typeof VidoraPlayer === "undefined") return;
    const live = VidoraPlayer.getLive();
    if (!live || live.stale) return;
    hostPlaying = live.playing;
    send("timeupdate", { currentTime: live.time, duration: live.duration }, live.playing);
  }

  function onHostEvent(e) {
    if (e.event === "pause") {
      clearTimeout(pendingSeekTimer); pendingSeekTimer = null;
      clearTimeout(pendingPauseTimer);
      pendingPauseTimer = setTimeout(() => {
        pendingPauseTimer = null;
        hostPlaying = false;
        send("pause", e, false);
      }, PAUSE_GRACE_MS);
      return;
    }
    if (e.event === "play") {
      clearTimeout(pendingSeekTimer); pendingSeekTimer = null;
      if (pendingPauseTimer) { clearTimeout(pendingPauseTimer); pendingPauseTimer = null; return; } // a blip
      hostPlaying = true;
      send("play", e, true);
      return;
    }
    if (e.event === "seeked") {
      clearTimeout(pendingPauseTimer); pendingPauseTimer = null;
      clearTimeout(pendingSeekTimer);
      pendingSeekTimer = setTimeout(() => {
        pendingSeekTimer = null;
        // `seeked` doesn't say whether the host is playing; use what we know.
        const playing = hostPlaying != null ? hostPlaying : !!e.playing;
        send("seeked", e, playing);
      }, SEEK_GRACE_MS);
      return;
    }
    if (e.event === "ended") {
      clearTimeout(pendingPauseTimer); pendingPauseTimer = null;
      clearTimeout(pendingSeekTimer); pendingSeekTimer = null;
      hostPlaying = false;
      send("ended", e, false);
      return;
    }
    // timeupdate
    if (hostPlaying === null) hostPlaying = true; // only fires while something is playing
    if (needsPrime) { send("timeupdate", e, hostPlaying); return; }
    if (hostPlaying && Date.now() - lastBroadcast > HEARTBEAT_MS) send("timeupdate", e, true);
  }

  // ---------------- presence ----------------
  // Everyone (host included) periodically reports where THEIR player is.
  // Informational for the people list, and it doubles as the keep-alive
  // that stops the server from pruning a quiet guest.
  let presenceTimer = null;
  let lastPresence = 0;

  function sendPresence() {
    if (!roomId || !myToken || typeof VidoraPlayer === "undefined") return;
    const live = VidoraPlayer.getLive();
    if (!live) return;
    lastPresence = Date.now();
    api("presence", { method: "POST", body: { roomId, token: myToken, time: live.time, playing: live.playing } }).catch(() => {});
  }
  function startPresence() {
    stopPresence();
    presenceTimer = setInterval(sendPresence, PRESENCE_MS);
  }
  function stopPresence() {
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
  }

  function onPlayerEvent(e) {
    if (!roomId) return;
    // Report immediately on state changes (so the list reacts quickly),
    // otherwise let the interval do it.
    if (e.event !== "timeupdate" && Date.now() - lastPresence > 3000) sendPresence();
    if (role === "host") onHostEvent(e);
  }
  if (typeof VidoraPlayer !== "undefined") VidoraPlayer.on(onPlayerEvent);

  // If this tab was in a party before a refresh, rejoin it.
  resume();

  return {
    createRoom, joinRoom, leaveRoom, resume, updateMedia, broadcastState, primeFromLive,
    isHost: () => role === "host",
    isGuest: () => role === "guest",
    inRoom: () => role !== null,
    getRoomId: () => roomId,
    getPassword: () => myPassword, // only ever the host's own password, typed by them — never sent to guests
    getMediaMeta: () => mediaMeta,
    getLastState: () => lastState,
    getHostPosition,
    getParticipants: () => participants,
    getMyName: () => myName,
    getMyAvatar: () => myAvatar,
    on, off,
  };
})();
