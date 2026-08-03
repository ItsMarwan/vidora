/**
 * VIDORA — WATCH PARTY (server-relayed)
 * -----------------------------------------------------------
 * No PeerJS, no WebRTC, no direct connection between participants'
 * browsers at all. Every action goes through /api/party/* on your own
 * Vercel deployment, backed by KV:
 *   - createRoom / joinRoom hit the server, which owns the password check
 *     and hands back a per-participant token.
 *   - The host pushes playback events to the server immediately.
 *   - Guests (and the host, lightly) poll the server for the latest state,
 *     media, and participant list.
 * This trades a little latency (poll interval, instead of an instant
 * WebRTC push) for never exposing anyone's IP to anyone else, and for
 * running entirely on infrastructure you already control.
 *
 * Public API is intentionally unchanged from the old peer-to-peer version
 * so party-ui.js didn't need to change at all.
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
  let roomId = null, myToken = null, myName = null, myPassword = null;
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

  async function api(path, opts = {}) {
    const res = await fetch(`/api/party${path}`, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
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
        const data = await api(`/${roomId}/state?token=${encodeURIComponent(myToken)}`);
        applyPoll(data);
      } catch (err) {
        stopPolling();
        emit("disconnect", err.message || "Lost connection to the party.");
      }
    }, intervalMs);
  }

  async function createRoom(meta, password, hostName) {
    leaveRoom(); // guard against a leaked, still-live room if createRoom is called again
    const data = await api("/create", { method: "POST", body: { name: hostName, password, mediaMeta: meta } });
    role = "host"; roomId = data.roomId; myToken = data.hostToken;
    myName = (hostName || "Host").slice(0, 20); myPassword = password;
    mediaMeta = cleanMeta(meta); lastState = null;
    participants = [{ id: "host", name: myName, host: true }];
    emit("participants", participants);
    startPolling();
    return roomId;
  }

  async function joinRoom(code, password, name) {
    leaveRoom();
    const data = await api("/join", { method: "POST", body: { roomId: code, password, name } });
    role = "guest"; roomId = String(code).toLowerCase(); myToken = data.guestToken;
    myName = (name || "Guest").slice(0, 20);
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
        const payload = new Blob([JSON.stringify({ token: myToken })], { type: "application/json" });
        if (navigator.sendBeacon) navigator.sendBeacon(`/api/party/${roomId}/leave`, payload);
      } catch (err) { /* best effort only */ }
    }
    role = null; roomId = null; myToken = null; myName = null; myPassword = null;
    mediaMeta = null; lastState = null; participants = [];
  }

  function broadcastState(stateObj) {
    if (role !== "host") return;
    lastState = stateObj;
    api(`/${roomId}/state`, { method: "POST", body: { token: myToken, ...stateObj } })
      .catch((err) => console.warn("[Watch Party] failed to push state:", err));
  }

  async function updateMedia(meta) {
    if (role !== "host") return;
    mediaMeta = cleanMeta(meta);
    lastState = null;
    try {
      await api(`/${roomId}/media`, { method: "POST", body: { token: myToken, mediaMeta } });
    } catch (err) {
      console.warn("[Watch Party] failed to update media:", err);
    }
  }

  // Same debounce/heartbeat logic as before — just pushing over a plain
  // fetch() to our own API instead of a WebRTC data channel.
  function createHostSync() {
    const PAUSE_GRACE_MS = 550;
    const HEARTBEAT_MS = 15000;
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
    on, off,
  };
})();
