/**
 * VIDORA — PLAYER MODULE
 * Builds embed URLs, and listens for PLAYER_EVENT postMessages — from an
 * embed iframe OR from a native <video> player (see js/mediaplayer.js) — to
 * keep a "Continue Watching" shelf in localStorage and to expose the live
 * playback position to the rest of the app (Watch Party).
 *
 * Two embed providers are supported, chosen per VidoraLang (js/i18n.js):
 *   - Vidy (English / default) — https://www.vidy.st/#docs. Query params:
 *     color, progress, autoplay, nextEpisode, episodeSelector,
 *     autoplayNextEpisode. Every flag is opt-in and takes `true`, so a
 *     flag that is off is left out of the URL entirely.
 *   - URPlayer (Arabic) — https://urplayer.net/#api. Its documented API
 *     is just /embed/movie/{tmdb_id} and
 *     /embed/tv/{tmdb_id}/{season}/{episode} with no query params.
 *
 * THE PLAYER EVENT PROTOCOL (what both kinds of player speak)
 *   player -> page : { type: "PLAYER_EVENT", data: { event, currentTime,
 *                      duration, [season, episode] } }
 *                    event is one of play | pause | seeked | ended | timeupdate
 *   The page never has to know which kind of player produced an event.
 *
 * PROGRESS: the position that "Resume" uses is only ever written from this
 * module, from the single listener below, for the title that is actually on
 * screen. See the notes next to each guard for the specific ways the saved
 * spot used to get clobbered.
 */

const VidoraPlayer = (() => {
  const STORAGE_KEY = "vidora_continue_watching";
  const MAX_SHELF_ENTRIES = 60;

  // ---------------- url builders ----------------

  // Appends a cache-busting param so every iframe src we hand out is a
  // unique URL (a stalled/broken response could otherwise be re-served from
  // the HTTP cache on every later load of the same movie/episode).
  function cacheBust(url) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}_=${Date.now().toString(36)}`;
  }

  function useArabicPlayer() {
    return typeof VidoraLang !== "undefined" && VidoraLang.isArabic();
  }

  function movieUrl(tmdbId, progressSeconds = 0, autoplay = VIDORA_CONFIG.PLAYER_AUTOPLAY) {
    if (useArabicPlayer()) {
      return cacheBust(`${VIDORA_CONFIG.URPLAYER_BASE_URL}/movie/${tmdbId}`);
    }
    const p = new URLSearchParams({ color: VIDORA_CONFIG.PLAYER_COLOR });
    if (autoplay) p.set("autoplay", "true");
    if (progressSeconds > 0) p.set("progress", Math.floor(progressSeconds));
    return cacheBust(`${VIDORA_CONFIG.VIDY_BASE_URL}/movie/${tmdbId}?${p.toString()}`);
  }

  function tvUrl(tmdbId, season, episode, progressSeconds = 0, autoplay = VIDORA_CONFIG.PLAYER_AUTOPLAY) {
    if (useArabicPlayer()) {
      return cacheBust(`${VIDORA_CONFIG.URPLAYER_BASE_URL}/tv/${tmdbId}/${season}/${episode}`);
    }
    const p = new URLSearchParams({ color: VIDORA_CONFIG.PLAYER_COLOR });
    if (autoplay) p.set("autoplay", "true");
    if (VIDORA_CONFIG.PLAYER_NEXT_EPISODE) p.set("nextEpisode", "true");
    if (VIDORA_CONFIG.PLAYER_EPISODE_SELECTOR) p.set("episodeSelector", "true");
    if (VIDORA_CONFIG.PLAYER_AUTOPLAY_NEXT_EPISODE) p.set("autoplayNextEpisode", "true");
    if (progressSeconds > 0) p.set("progress", Math.floor(progressSeconds));
    return cacheBust(`${VIDORA_CONFIG.VIDY_BASE_URL}/tv/${tmdbId}/${season}/${episode}?${p.toString()}`);
  }

  // ---------------- continue-watching shelf ----------------

  function readShelf() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  // localStorage can throw (quota exceeded, private mode). This runs inside
  // a global message handler, so an uncaught throw there used to abort the
  // handler before it ever notified Watch Party of the event.
  function writeShelf(shelf) {
    try {
      const keys = Object.keys(shelf);
      if (keys.length > MAX_SHELF_ENTRIES) {
        keys.sort((a, b) => (shelf[b].timestamp || 0) - (shelf[a].timestamp || 0))
          .slice(MAX_SHELF_ENTRIES).forEach((k) => delete shelf[k]);
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(shelf));
    } catch (err) {
      console.warn("[Vidora] couldn't save watch progress:", err);
    }
  }

  function keyFor(meta) {
    return meta.mediaType === "tv" ? `tv-${meta.id}-${meta.season}-${meta.episode}` : `movie-${meta.id}`;
  }

  function saveProgress(meta, pos) {
    const shelf = readShelf();
    shelf[keyFor(meta)] = {
      id: meta.id, title: meta.title, mediaType: meta.mediaType, poster: meta.poster,
      season: meta.season, episode: meta.episode,
      currentTime: pos.currentTime, duration: pos.duration,
      progress: pos.duration ? pos.currentTime / pos.duration : 0,
      timestamp: Date.now(),
    };
    writeShelf(shelf);
  }

  function getProgress(id, mediaType, season, episode) {
    const shelf = readShelf();
    const key = mediaType === "tv" ? `tv-${id}-${season}-${episode}` : `movie-${id}`;
    return shelf[key] || null;
  }

  // One tile per title: a show you've watched five episodes of has five
  // shelf entries (progress is per episode), but the Continue Watching row
  // should show only the most recent one.
  function getContinueWatching() {
    const sorted = Object.values(readShelf()).sort((a, b) => b.timestamp - a.timestamp);
    const seen = new Set();
    return sorted.filter((e) => {
      const k = `${e.mediaType}-${e.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ---------------- live playback tracking ----------------
  // Module-level on purpose: ONE window listener for the page's lifetime,
  // pointed at whichever title is on screen via `currentMeta`. (Registering
  // a fresh listener per watch page used to leave stale closures alive that
  // saved the wrong title's progress.)
  let currentMeta = null;
  let metaChangeCb = null;
  let lastSave = 0;
  let lastKnown = null;   // { currentTime, duration } for currentMeta, used to flush on exit
  const subscribers = new Set();

  // The most recent reading from the player that's on screen, for anyone who
  // needs to know "where is this person right now" (Watch Party).
  let live = { time: null, duration: 0, playing: null, event: null, at: 0 };

  function saveInterval() {
    return VIDORA_CONFIG.PROGRESS_SAVE_INTERVAL_MS || 120000;
  }

  // Persists the last position we saw, bypassing the throttle. Used when we
  // might otherwise lose up to a whole save-interval: switching titles,
  // hiding the tab, closing it, or leaving the watch page.
  function flush() {
    if (!currentMeta || !lastKnown) return;
    if (!mayCheckpoint(lastKnown)) return; // see PROTECT_BELOW_SECONDS
    saveProgress(currentMeta, lastKnown);
    lastSave = Date.now();
  }

  // Never overwrite an existing resume point with a position from the first
  // few seconds of playback. A fresh load reports ~0:00 immediately, which
  // used to replace the saved 40:00 before the person had even answered the
  // "Resume where you left off?" prompt — so closing the tab, or answering
  // "start over" and leaving, silently erased their spot.
  const PROTECT_BELOW_SECONDS = 20;
  function mayCheckpoint(pos) {
    if (pos.currentTime >= PROTECT_BELOW_SECONDS) return true;
    return !getProgress(currentMeta.id, currentMeta.mediaType, currentMeta.season, currentMeta.episode);
  }

  function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }

  // Is the video playing right now? Native players say so outright
  // (`paused`). Embed players only emit events, so infer: "seeked" says
  // nothing about play state (a paused person can scrub), so it keeps
  // whatever we last knew; "timeupdate" only fires during playback.
  function inferPlaying(e) {
    if (typeof e.paused === "boolean") return !e.paused && e.event !== "ended";
    if (e.event === "play" || e.event === "timeupdate") return true;
    if (e.event === "pause" || e.event === "ended") return false;
    return live.playing == null ? true : live.playing;
  }

  function handlePlayerMessage(event) {
    let data;
    try {
      data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!data || data.type !== "PLAYER_EVENT") return;
    if (!currentMeta) return; // no watch page is currently tracking playback
    const e = data.data || {};
    const currentTime = num(e.currentTime);
    const duration = num(e.duration);
    const now = Date.now();

    // Embed players with their own episode controls (Vidy's next-episode
    // button / auto-advance) keep playing inside the same iframe while our
    // page still believes it's on the old episode. Attributing the new
    // episode's events to the old key overwrote the old episode's resume
    // point with the new episode's position. Follow what's actually playing.
    if (currentMeta.mediaType === "tv" && e.season != null && e.episode != null &&
        (String(e.season) !== String(currentMeta.season) || String(e.episode) !== String(currentMeta.episode))) {
      flush();
      currentMeta = { ...currentMeta, season: String(e.season), episode: String(e.episode) };
      lastKnown = null; lastSave = 0;
      if (metaChangeCb) { try { metaChangeCb(currentMeta); } catch (err) { console.error(err); } }
    }

    if (e.event === "ended") {
      const shelf = readShelf();
      delete shelf[keyFor(currentMeta)];
      writeShelf(shelf);
      lastKnown = null;
      live = { time: currentTime ?? live.time, duration: duration || live.duration, playing: false, event: "ended", at: now };
    } else {
      if (currentTime === null || currentTime < 0) return;
      live = {
        time: currentTime,
        duration: duration && duration > 0 ? duration : live.duration,
        playing: inferPlaying(e),
        event: e.event || "timeupdate",
        at: now,
      };
    }

    // Subscribers (Watch Party) are told about EVERY event immediately —
    // never gated on duration being known yet or on a storage write.
    const norm = { event: e.event || "timeupdate", currentTime: live.time, duration: live.duration, playing: live.playing, remote: !!e.remote };
    subscribers.forEach((cb) => { try { cb(norm); } catch (err) { console.error("[Vidora] player listener error:", err); } });

    if (e.event === "ended") return;

    // A missing duration only blocks the Continue Watching checkpoint,
    // which needs a real duration to compute a progress fraction.
    if (!(duration && duration > 0)) return;
    lastKnown = { currentTime, duration };

    if (now - lastSave < saveInterval()) return;
    if (!mayCheckpoint(lastKnown)) return;
    lastSave = now;
    saveProgress(currentMeta, lastKnown);
  }

  window.addEventListener("message", handlePlayerMessage);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);

  // init({id,title,mediaType,poster,season,episode}, {onMetaChange}) — call
  // when a watch page renders.
  function init(meta, opts = {}) {
    flush(); // persist wherever the PREVIOUS title left off before switching
    currentMeta = meta;
    metaChangeCb = opts.onMetaChange || null;
    lastSave = 0;
    lastKnown = null;
    live = { time: null, duration: 0, playing: null, event: null, at: 0 };
  }

  // Call when leaving the watch page. Without this, `currentMeta` stayed
  // pointed at the last title forever, so any late event (or the pagehide
  // flush) could still write to it.
  function stop() {
    flush();
    currentMeta = null;
    metaChangeCb = null;
    lastKnown = null;
    live = { time: null, duration: 0, playing: null, event: null, at: 0 };
  }

  function on(cb) {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }

  // Current position, projected forward a little while playing (events
  // arrive every ~0.25–1s). Null until the player has reported at least once.
  const MAX_PROJECT_SEC = 3;
  function getLive() {
    if (live.time == null) return null;
    let time = live.time;
    if (live.playing) time += Math.min(MAX_PROJECT_SEC, (Date.now() - live.at) / 1000);
    return { time, playing: !!live.playing, duration: live.duration, event: live.event, at: live.at, stale: Date.now() - live.at > 6000 };
  }

  return { movieUrl, tvUrl, getProgress, getContinueWatching, init, stop, on, getLive };
})();
