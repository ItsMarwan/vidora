/**
 * VIDORA — WATCH PARTY (server-relayed)
 * -----------------------------------------------------------
 * No PeerJS, no WebRTC, no direct connection between participants'
 * browsers at all. Every action goes through the single /api/party
 * endpoint on your own Vercel deployment, backed by KV:
 *   - createRoom / joinRoom hit the server, which owns the password check
 *     and hands back a per-participant token.
 *   - The host pushes playback events to the server immediately.
 *   - Guests (and the host, lightly) poll the server for the latest state,
 *     media, and participant list.
 * This trades a little latency (poll interval, instead of an instant
 * WebRTC push) for never exposing anyone's IP to anyone else, and for
 * running entirely on infrastructure you already control.
 *
 * The server route is one flat file (no nested URL segments) — every
 * call here goes to /api/party with an `action` field (query string for
 * GET, JSON body for POST) instead of a path like /api/party/<room>/state.
 *
 * If a local profile exists (VidoraProfile), its name and small avatar
 * image are used automatically for both hosting and joining, so nobody
 * has to type their name every time — an explicit name passed to
 * createRoom/joinRoom still wins if given (e.g. someone without a profile
 * who typed one into the modal).
 * -----------------------------------------------------------
 */

const VidoraParty = (() => {
  const listeners = { participants: [], state: [], media: [], disconnect: [] };
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

  let role = null; // 'host' | 'guest' | null
  let roomId = null, myToken = null, myName = null, myPassword = null, myAvatar = null;
  let mediaMeta = null, lastState = null, participants = [];
  let pollTimer = null;

  const GUEST_POLL_MS = 1800; // how often guests check for updates
  const HOST_POLL_MS = 4000;  // host is authoritative; only polling for new participants

  function cleanMeta(meta) {
    if (!meta) return null;
    return {
      mediaType: meta.mediaType, id: meta.id, title: meta.title,
      poster: meta.poster, season: meta.season, episode: meta.episode,
    };
  }

  // Falls back to the local profile's name/photo whenever an explicit
  // value wasn't provided (e.g. the name field was hidden because a
  // profile already exists).
  function resolveIdentity(explicitName) {
    const profile = window.VidoraProfile && VidoraProfile.getProfile();
    const name = (explicitName && explicitName.trim()) || (profile && profile.name) || null;
    const avatar = (profile && profile.image) || null;
    return { name, avatar };
  }

  // Single flat endpoint. `action` goes in the query string for GET
  // requests and in the JSON body for POST requests — never in the URL
  // path, so there's no dynamic route segment involved on either end.
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
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function applyPoll(data) {
    const participantsChanged = JSON.stringify(data.participants) !== JSON.stringify(participants);
    participants = data.participants || [];
    if (participantsChanged) emit("participants", participants);

    if (role !== "guest") return; // host is authoritative for its own media/state

    const sameMedia = mediaMeta && data.mediaMeta &&
      mediaMeta.mediaType === data.mediaMeta.mediaType &&
      String(mediaMeta.id) === String(data.mediaMeta.id) &&
      String(mediaMeta.season) === String(data.mediaMeta.season) &&
      String(mediaMeta.episode) === String(data.mediaMeta.episode);
    if (data.mediaMeta && !sameMedia) {
      mediaMeta = data.mediaMeta;
      emit("media", mediaMeta);
    }
    if (data.lastState && JSON.stringify(data.lastState) !== JSON.stringify(lastState)) {
      lastState = data.lastState;
      emit("state", lastState);
    }
  }

  function startPolling() {
    stopPolling();
    const intervalMs = role === "host" ? HOST_POLL_MS : GUEST_POLL_MS;
    pollTimer = setInterval(async () => {
      if (!roomId || !myToken) return;
      try {
        const data = await api("state", { query: { roomId, token: myToken } });
        applyPoll(data);
      } catch (err) {
        stopPolling();
        emit("disconnect", err.message || "Lost connection to the party.");
      }
    }, intervalMs);
  }

  async function createRoom(meta, password, hostName) {
    leaveRoom(); // guard against a leaked, still-live room if createRoom is called again
    const { name, avatar } = resolveIdentity(hostName);
    const data = await api("create", { method: "POST", body: { name: name || "Host", password, mediaMeta: meta, avatar } });
    role = "host"; roomId = data.roomId; myToken = data.hostToken;
    myName = (name || "Host").slice(0, 20); myPassword = password; myAvatar = avatar;
    mediaMeta = cleanMeta(meta); lastState = null;
    participants = [{ id: "host", name: myName, host: true, avatar: myAvatar }];
    emit("participants", participants);
    startPolling();
    return roomId;
  }

  async function joinRoom(code, password, name) {
    leaveRoom();
    const identity = resolveIdentity(name);
    const data = await api("join", { method: "POST", body: { roomId: code, password, name: identity.name || "Guest", avatar: identity.avatar } });
    role = "guest"; roomId = String(code).toLowerCase(); myToken = data.guestToken;
    myName = (identity.name || "Guest").slice(0, 20); myAvatar = identity.avatar;
    mediaMeta = data.mediaMeta; lastState = data.lastState; participants = data.participants || [];
    emit("participants", participants);
    startPolling();
    return mediaMeta;
  }

  function leaveRoom() {
    stopPolling();
    if (roomId && myToken) {
      // Best-effort, fire-and-forget notice so the server (and everyone
      // else) finds out immediately instead of waiting for a poll to fail.
      try {
        const payload = new Blob(
          [JSON.stringify({ action: "leave", roomId, token: myToken })],
          { type: "application/json" },
        );
        if (navigator.sendBeacon) navigator.sendBeacon("/api/party", payload);
      } catch (err) { /* best effort only */ }
    }
    role = null; roomId = null; myToken = null; myName = null; myPassword = null; myAvatar = null;
    mediaMeta = null; lastState = null; participants = [];
  }

  function broadcastState(stateObj) {
    if (role !== "host") return;
    lastState = stateObj;
    api("state", { method: "POST", body: { roomId, token: myToken, ...stateObj } })
      .catch((err) => console.warn("[Watch Party] failed to push state:", err));
  }

  async function updateMedia(meta) {
    if (role !== "host") return;
    mediaMeta = cleanMeta(meta);
    lastState = null;
    try {
      await api("media", { method: "POST", body: { roomId, token: myToken, mediaMeta } });
    } catch (err) {
      console.warn("[Watch Party] failed to update media:", err);
    }
  }

  // Same debounce/heartbeat logic as before — just pushing over a plain
  // fetch() to our own API instead of a WebRTC data channel.
  function createHostSync() {
    const PAUSE_GRACE_MS = 550;
    // Periodic sync-check anchor: even while nothing changes (host just
    // keeps playing), push a "timeupdate" every 2 minutes so guests have a
    // fresh reference point to check their own drift against — this is
    // what makes the resync check in party-ui.js actually recurring instead
    // of only firing on play/pause/seek.
    const HEARTBEAT_MS = 120000;
    let lastBroadcast = 0;
    let isPlaying = false;
    let pendingPauseTimer = null;

    function clearPending() {
      if (pendingPauseTimer) { clearTimeout(pendingPauseTimer); pendingPauseTimer = null; }
    }
    function send(evt) {
      broadcastState(evt);
      lastBroadcast = Date.now();
    }

    return function onPlayerEvent(e) {
      if (role !== "host") { clearPending(); return; }

      if (e.event === "pause") {
        clearPending();
        pendingPauseTimer = setTimeout(() => {
          pendingPauseTimer = null;
          isPlaying = false;
          send({ event: "pause", currentTime: e.currentTime, duration: e.duration });
        }, PAUSE_GRACE_MS);
        return;
      }
      if (e.event === "play") {
        if (pendingPauseTimer) { clearPending(); return; } // it was a blip
        isPlaying = true;
        send({ event: "play", currentTime: e.currentTime, duration: e.duration });
        return;
      }
      if (e.event === "seeked" || e.event === "ended") {
        clearPending();
        if (e.event === "ended") isPlaying = false;
        send({ event: e.event, currentTime: e.currentTime, duration: e.duration });
        return;
      }
      if (isPlaying && Date.now() - lastBroadcast > HEARTBEAT_MS) {
        send({ event: "timeupdate", currentTime: e.currentTime, duration: e.duration });
      }
    };
  }

  window.addEventListener("beforeunload", () => { try { leaveRoom(); } catch (err) {} });

  return {
    createRoom, joinRoom, leaveRoom, broadcastState, updateMedia, createHostSync,
    isHost: () => role === "host",
    isGuest: () => role === "guest",
    inRoom: () => role !== null,
    getRoomId: () => roomId,
    getPassword: () => myPassword, // only ever the host's own password, typed by them — never sent to guests
    getMediaMeta: () => mediaMeta,
    getLastState: () => lastState,
    getParticipants: () => participants,
    getMyName: () => myName,
    getMyAvatar: () => myAvatar,
    on, off,
  };
})();
