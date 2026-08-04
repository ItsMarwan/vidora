/**
 * VIDORA — LANGUAGE / PLAYER-SOURCE SWITCH
 * -----------------------------------------------------------
 * Two supported modes, picked from the navbar flag switch:
 *   "en" — Vidking embed player (js/player.js's original behavior)
 *   "ar" — URPlayer embed player (https://urplayer.net/#api)
 * The choice only changes WHICH embed provider gets used for playback;
 * it doesn't translate the rest of the UI. It's persisted in
 * localStorage under its own key (isolated from the continue-watching /
 * my-list / watch-party storage) and broadcast to any listeners so the
 * player module and the currently-open page can react immediately.
 * -----------------------------------------------------------
 */

const VidoraLang = (() => {
  const STORAGE_KEY = "vidora_language";
  const SUPPORTED = ["en", "ar"];
  const listeners = [];
  let current = "en";

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (SUPPORTED.includes(saved)) current = saved;
  } catch {
    // localStorage unavailable (private mode, etc.) — fall back to "en"
  }

  function applyToDom() {
    // Only the <html> lang/dir attributes are flipped — Vidora's own UI
    // stays in English text, this just marks which player/content
    // language is active and keeps the attributes accurate for a11y.
    document.documentElement.setAttribute("lang", current);
    document.documentElement.setAttribute("dir", current === "ar" ? "rtl" : "ltr");
    document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
      const active = btn.dataset.langBtn === current;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

  function set(lang) {
    if (!SUPPORTED.includes(lang) || lang === current) return;
    current = lang;
    try { localStorage.setItem(STORAGE_KEY, current); } catch {}
    applyToDom();
    listeners.forEach((fn) => {
      try { fn(current); } catch (err) { console.error("[VidoraLang] listener error:", err); }
    });
  }

  function get() { return current; }
  function isArabic() { return current === "ar"; }

  function on(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i > -1) listeners.splice(i, 1);
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyToDom);
  } else {
    applyToDom();
  }

  // Delegated click handler covers the switch wherever it's rendered
  // (currently the desktop navbar) without needing a direct reference.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-lang-btn]");
    if (!btn) return;
    const next = btn.dataset.langBtn;
    if (next === current) return;
    set(next);
    if (window.VD && VD.toast) {
      VD.toast(next === "ar" ? "Switched to the Arabic player (URPlayer)" : "Switched to the English player (Vidking)");
    }
    // Re-render whatever's currently on screen so any visible iframe picks
    // up the new provider immediately instead of waiting for the next
    // navigation. navigate() with the current path calls route() directly
    // (see js/app.js) rather than pushing a new history entry.
    if (window.vidoraNavigate) window.vidoraNavigate(location.pathname + location.search);
  });

  return { get, set, isArabic, on, SUPPORTED };
})();
