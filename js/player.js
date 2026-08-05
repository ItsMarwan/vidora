/**
 * VIDORA — PLAYER MODULE
 * Builds player iframe URLs and listens for PLAYER_EVENT postMessages to
 * keep a "Continue Watching" shelf in localStorage, isolated under its
 * own key.
 *
 * Two embed providers are supported, chosen per VidoraLang (js/i18n.js):
 *   - Vidking (English / default) — documented query params for color,
 *     autoplay, progress, next-episode and episode-selector.
 *   - URPlayer (Arabic) — https://urplayer.net/#api. Its documented API
 *     is just /embed/movie/{tmdb_id} and
 *     /embed/tv/{tmdb_id}/{season}/{episode} with no query params, so
 *     those builders skip all the Vidking-specific options.
 * Continue Watching / progress tracking is provider-agnostic — it only
 * cares about the postMessage PLAYER_EVENT payload, which both providers
 * are expected to emit the same way.
 */

const VidoraPlayer = (() => {
  const STORAGE_KEY = "vidora_continue_watching";

  // ---------------- url builders ----------------

  // Appends a cache-busting param so every iframe src we hand out is a
  // unique URL. Without this, reloading the SAME movie/episode URL (which
  // happens on every revisit, and on every Watch Party sync reload) could
  // be served back from the browser's HTTP cache instead of hitting the
  // network — and if that cached response ever got captured mid-glitch
  // (a stalled frame, a broken player state), every future load of that
  // exact URL kept re-serving the same broken snapshot until the person
  // manually cleared their cache. A unique URL per load sidesteps that
  // entirely.
  function cacheBust(url) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}_=${Date.now().toString(36)}`;
  }

  function useArabicPlayer() {
    return typeof VidoraLang !== "undefined" && VidoraLang.isArabic();
  }

  function movieUrl(tmdbId, progressSeconds = 0, autoplay = VIDORA_CONFIG.PLAYER_AUTOPLAY) {
    if (useArabicPlayer()) {
      // URPlayer's documented movie embed takes only the TMDB id — no
      // progress/autoplay query params to pass through.
      return cacheBust(`${VIDORA_CONFIG.URPLAYER_BASE_URL}/movie/${tmdbId}`);
    }
    const p = new URLSearchParams({
      color: VIDORA_CONFIG.PLAYER_COLOR,
      autoPlay: String(autoplay),
    });
    if (progressSeconds > 0) p.set("progress", Math.floor(progressSeconds));
    return cacheBust(`${VIDORA_CONFIG.VIDKING_BASE_URL}/movie/${tmdbId}?${p.toString()}`);
  }

  function tvUrl(tmdbId, season, episode, progressSeconds = 0, autoplay = VIDORA_CONFIG.PLAYER_AUTOPLAY) {
    if (useArabicPlayer()) {
      // URPlayer's documented TV embed: /embed/tv/{tmdb_id}/{season}/{episode}
      return cacheBust(`${VIDORA_CONFIG.URPLAYER_BASE_URL}/tv/${tmdbId}/${season}/${episode}`);
    }
    const p = new URLSearchParams({
      color: VIDORA_CONFIG.PLAYER_COLOR,
      autoPlay: String(autoplay),
      nextEpisode: String(VIDORA_CONFIG.PLAYER_NEXT_EPISODE),
      episodeSelector: String(VIDORA_CONFIG.PLAYER_EPISODE_SELECTOR),
    });
    if (progressSeconds > 0) p.set("progress", Math.floor(progressSeconds));
    return cacheBust(`${VIDORA_CONFIG.VIDKING_BASE_URL}/tv/${tmdbId}/${season}/${episode}?${p.toString()}`);
  }

  // ---------------- continue-watching shelf ----------------

  function readShelf() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function writeShelf(shelf) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shelf));
  }

  function keyFor(meta) {
    return meta.mediaType === "tv" ? `tv-${meta.id}-${meta.season}-${meta.episode}` : `movie-${meta.id}`;
  }

  function saveProgress(meta, e) {
    const shelf = readShelf();
    shelf[keyFor(meta)] = {
      id: meta.id, title: meta.title, mediaType: meta.mediaType, poster: meta.poster,
      season: meta.season, episode: meta.episode,
      currentTime: e.currentTime, duration: e.duration,
      progress: e.duration ? e.currentTime / e.duration : 0,
      timestamp: Date.now(),
    };
    writeShelf(shelf);
  }

  function getProgress(id, mediaType, season, episode) {
    const shelf = readShelf();
    const key = mediaType === "tv" ? `tv-${id}-${season}-${episode}` : `movie-${id}`;
    return shelf[key] || null;
  }

  function getContinueWatching() {
    const shelf = readShelf();
    return Object.values(shelf).sort((a, b) => b.timestamp - a.timestamp);
  }

  // ---------------- live playback tracking ----------------
  // These are module-level (not per-call) on purpose: init() used to add a
  // brand-new `window.addEventListener("message", ...)` closure every time
  // a watch page rendered, and none of them were ever removed. Because
  // postMessage events are global, every one of those stale listeners kept
  // receiving events from whatever video was CURRENTLY playing and, since
  // each closure had captured its OWN (now-stale) `meta`, it would save —
  // or on "ended", delete — the wrong title's Continue Watching entry.
  // That cross-talk is what made playback seem to randomly "snap back" to
  // an old position: a stale listener from a previously-watched title was
  // silently overwriting the current title's saved progress with numbers
  // that belonged to a different video entirely.
  //
  // Registering one listener for the page's lifetime and just repointing
  // `currentMeta`/`onUpdateCb` on every init() call keeps exactly one
  // listener alive, tracking whichever title is actually on screen.
  let currentMeta = null;
  let onUpdateCb = null;
  let lastSave = 0;
  let lastKnown = null; // {currentTime, duration} for currentMeta, used to flush on exit

  function saveInterval() {
    return VIDORA_CONFIG.PROGRESS_SAVE_INTERVAL_MS || 120000; // 2 minutes by default
  }

  // Persists whatever position we last saw immediately, bypassing the
  // throttle. Used whenever we might otherwise lose up to a full
  // save-interval of progress: switching titles, hiding/backgrounding the
  // tab, or closing it.
  function flush() {
    if (!currentMeta || !lastKnown) return;
    saveProgress(currentMeta, lastKnown);
    lastSave = Date.now();
  }

  window.addEventListener("message", (event) => {
    let data;
    try {
      data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!data || data.type !== "PLAYER_EVENT") return;
    if (!currentMeta) return; // no watch page is currently tracking playback
    const e = data.data || {};

    if (e.event === "ended") {
      const shelf = readShelf();
      delete shelf[keyFor(currentMeta)];
      writeShelf(shelf);
      lastKnown = null;
      if (onUpdateCb) onUpdateCb(e);
      return;
    }
    if (typeof e.currentTime !== "number" || !Number.isFinite(e.currentTime) || e.currentTime < 0) return;

    // Duration isn't always known yet — some providers fire the very
    // first "play" event (e.g. the moment a Watch Party host presses play
    // on a freshly-loaded title) before the video's metadata/duration has
    // finished loading, so duration comes through as 0/NaN at that
    // instant. This used to make the whole handler bail out early and
    // never call onUpdateCb at all for that event — which meant the
    // host's very first "play" never reached Watch Party's sync, so
    // guests stayed stuck on a stopped screen even though the host was
    // actually playing (pause worked fine because by then duration had
    // already loaded). A missing duration should only block the
    // "Continue Watching" checkpoint below (which genuinely needs a real
    // duration to compute a progress fraction) — it should never block
    // the live event notification itself.
    const hasValidDuration = typeof e.duration === "number" && Number.isFinite(e.duration) && e.duration > 0;
    if (hasValidDuration) lastKnown = { currentTime: e.currentTime, duration: e.duration };

    // Notify listeners (Watch Party sync, etc.) immediately for every event,
    // including play/pause/seeked — this must never be gated on duration
    // being loaded yet, or on a localStorage write, or pausing/seeking (and,
    // previously, that very first play) can feel like it's not responding.
    if (onUpdateCb) onUpdateCb(e);

    if (!hasValidDuration) return; // nothing to checkpoint locally without a real duration yet

    // The localStorage write ("Continue Watching" resume point) is
    // checkpointed every ~2 minutes (VIDORA_CONFIG.PROGRESS_SAVE_INTERVAL_MS)
    // for all events — not just plain timeupdate ticks — so we're not doing
    // a synchronous disk write on every play/pause/seek too. `flush()` below
    // covers the gap between checkpoints when the tab is hidden or closed.
    const now = Date.now();
    if (now - lastSave < saveInterval()) return;
    lastSave = now;
    saveProgress(currentMeta, e);
  });

  // Catch the cases a fixed interval alone would miss: closing the tab,
  // switching apps, or locking the phone a few seconds after pausing —
  // all of which could otherwise lose up to ~2 minutes of watched progress.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);

  function init(meta, onUpdate) {
    // meta: { id, title, mediaType, poster, season, episode }
    flush(); // persist wherever the PREVIOUS title left off before switching
    currentMeta = meta;
    onUpdateCb = onUpdate || null;
    lastSave = 0;
    lastKnown = null;
  }

  return { movieUrl, tvUrl, getProgress, getContinueWatching, init };
})();