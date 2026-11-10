/**
 * VIDORA — PLAYBACK STAGE
 * -----------------------------------------------------------
 * Owns the box on the watch page where video appears (#vidoraStage) and
 * hides the difference between the two kinds of player that can live in it:
 *
 *   iframe  A third-party embed (Vidy / URPlayer). We can't talk to it;
 *           the only way to move it is to reload it with a new start
 *           position. Reloads are disruptive, so they're rate-limited and
 *           coalesced to the latest target.
 *
 *   native  The Vidora media player (extension/src/mediaplayer.js) — either
 *           created by the page via VidoraStage.playNative(), or injected
 *           by the browser extension, which replaces whatever is in the
 *           stage. It speaks the player protocol (see that file), so Watch
 *           Party can simply tell it "go to 12:03 and play" — no reload,
 *           no re-buffering, no autoplay roulette.
 *
 * The stage notices a native player by its VIDORA_PLAYER_READY message, so
 * it doesn't matter who created it. From then on `sync()` commands it
 * instead of reloading an iframe that no longer exists.
 * -----------------------------------------------------------
 */

const VidoraStage = (() => {
  const RELOAD_COOLDOWN_MS = 3000;
  let current = null;

  function postCmd(cmd, extra) {
    try { window.postMessage({ type: "VIDORA_PLAYER_CMD", cmd, ...(extra || {}) }, "*"); } catch { /* ignore */ }
  }

  function create({ container, buildIframeUrl, title }) {
    teardown();

    let iframe = null;
    let mode = "idle"; // 'idle' | 'iframe' | 'native'
    let nativeId = null;
    let reloadCooldownUntil = 0;
    let coalesceTimer = null;
    let destroyed = false;
    const nativeCbs = new Set();
    const statusCbs = new Set();

    function clearCoalesce() {
      if (coalesceTimer) { clearTimeout(coalesceTimer); coalesceTimer = null; }
    }

    function removeIframe() {
      if (!iframe) return;
      try { iframe.src = "about:blank"; } catch { /* ignore */ }
      iframe.remove();
      iframe = null;
    }

    // ---------------- iframe backend ----------------
    function loadIframe(time, autoplay) {
      if (destroyed) return;
      clearCoalesce();
      if (mode === "native") {
        // taking the stage back from a native player
        postCmd("destroy");
        container.querySelectorAll("#vidora-custom-player-host").forEach((el) => el.remove());
        nativeId = null;
      }
      if (!iframe) {
        iframe = document.createElement("iframe");
        iframe.setAttribute("allowfullscreen", "");
        // per the Vidy docs: "*" so autoplay still works if the embed redirects to another origin
        iframe.setAttribute("allow", "encrypted-media; autoplay *; fullscreen *");
        iframe.title = title ? `${title} — player` : "Video player";
        container.appendChild(iframe);
      }
      iframe.src = buildIframeUrl(Math.max(0, time || 0), autoplay !== false);
      mode = "iframe";
      reloadCooldownUntil = Date.now() + RELOAD_COOLDOWN_MS;
    }

    // Reload-based sync for embeds. `getTarget` is called when the reload
    // actually happens, so a reload that had to wait out the cooldown still
    // lands on where the host is NOW, not where it was when we asked.
    function reloadTo(getTarget) {
      const wait = reloadCooldownUntil - Date.now();
      if (wait <= 0) {
        const t = getTarget();
        if (t) loadIframe(t.time, t.playing);
        return;
      }
      clearCoalesce();
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        const t = getTarget();
        if (t) loadIframe(t.time, t.playing);
      }, wait);
    }

    // ---------------- native backend ----------------
    async function playNative(movie, opts = {}) {
      if (destroyed) return null;
      if (!window.VidoraNativePlayer) throw new Error("The native player isn't loaded.");
      clearCoalesce();
      removeIframe();
      mode = "native"; // set first: the player's READY message arrives before create() resolves
      return window.VidoraNativePlayer.create({
        movie, container, startTime: opts.startTime || 0, autoplay: opts.autoplay !== false,
      });
    }

    // ---------------- protocol messages from native players ----------------
    function onMessage(ev) {
      if (ev.source !== window) return;
      let d = ev.data;
      if (typeof d === "string") { try { d = JSON.parse(d); } catch { return; } }
      if (!d || typeof d !== "object") return;

      if (d.type === "VIDORA_PLAYER_READY") {
        if (d.playerId === nativeId) return;
        nativeId = d.playerId;
        clearCoalesce();
        removeIframe(); // an extension may have swapped the DOM already; this is the tidy-up
        mode = "native";
        nativeCbs.forEach((cb) => { try { cb(d); } catch (err) { console.error(err); } });
        return;
      }
      if (d.type === "VIDORA_PLAYER_STATUS" && d.playerId === nativeId) {
        statusCbs.forEach((cb) => { try { cb(d.status); } catch (err) { console.error(err); } });
      }
    }
    window.addEventListener("message", onMessage);

    // ---------------- public ----------------
    const stage = {
      get mode() { return mode; },
      isNative: () => mode === "native",
      loadIframe,
      playNative,

      // Bring the player to where `getTarget()` says it should be.
      //   getTarget(): { time, playing } | null
      //   opts.tolerance: seconds of drift to ignore (native only)
      //   opts.reload: for iframes, whether this is worth a reload at all
      //   opts.immediate: for iframes, reload now instead of after the cooldown
      sync(getTarget, opts = {}) {
        if (destroyed) return false;
        const t = getTarget();
        if (!t) return false;
        if (mode === "native") {
          postCmd("sync", { time: t.time, playing: !!t.playing, tolerance: opts.tolerance });
          return true;
        }
        if (opts.reload === false) return false;
        if (opts.immediate) loadIframe(t.time, t.playing); // explicit "Sync now": don't wait out the cooldown
        else reloadTo(getTarget);
        return true;
      },

      // Jump to an absolute position (used by "Resume").
      seek(time, autoplay = true) {
        if (mode === "native") { postCmd("sync", { time, playing: autoplay, tolerance: 0 }); return; }
        loadIframe(time, autoplay);
      },

      // Native player asks for a tap (autoplay blocked) / reports errors.
      onStatus(cb) { statusCbs.add(cb); return () => statusCbs.delete(cb); },
      // A native player became active (extension injected one, or playNative()).
      onNative(cb) { nativeCbs.add(cb); return () => nativeCbs.delete(cb); },

      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearCoalesce();
        window.removeEventListener("message", onMessage);
        if (mode === "native") postCmd("destroy");
        removeIframe();
        nativeCbs.clear();
        statusCbs.clear();
      },
    };

    // If a native player was already announced before this stage existed
    // (e.g. the extension injected during a fast SPA navigation), ask it to
    // identify itself so we adopt it.
    postCmd("ping");

    current = stage;
    return stage;
  }

  // Called by the router on every navigation so a player (and its message
  // listeners) never outlives the page it belonged to.
  function teardown() {
    if (current) { current.destroy(); current = null; }
  }

  return { create, teardown, getCurrent: () => current };
})();
