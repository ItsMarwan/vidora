/**
 * VIDORA — CLIENT CONFIG
 * -----------------------------------------------------------
 * Client-safe values live here, but they are hydrated from the server-side
 * /api/config endpoint so the app can pick up deployment-specific settings
 * without exposing secrets.
 * -----------------------------------------------------------
 */
const VIDORA_CONFIG = {
  API_BASE: "/api",
  // Vidy (https://www.vidy.st/#docs): /movie/{tmdbId} and
  // /tv/{tmdbId}/{season}/{episode}, flags are opt-in and take `true`.
  VIDY_BASE_URL: "https://vidy.st",
  // Arabic-language player (see js/i18n.js) — used instead of Vidy
  // whenever VidoraLang.isArabic() is true. Per URPlayer's documented
  // API, embed URLs are /embed/movie/{tmdb_id} and
  // /embed/tv/{tmdb_id}/{season}/{episode} — no query params documented,
  // so js/player.js doesn't attach the Vidy-specific ones here.
  URPLAYER_BASE_URL: "https://urplayer.net/embed",
  PLAYER_COLOR: "e8b84b",
  PLAYER_AUTOPLAY: true,
  PLAYER_NEXT_EPISODE: true,
  PLAYER_EPISODE_SELECTOR: true,
  PLAYER_AUTOPLAY_NEXT_EPISODE: true,
  PROGRESS_SAVE_INTERVAL_MS: 120000,
};

window.VIDORA_CONFIG = VIDORA_CONFIG;

fetch("/api/config", { headers: { Accept: "application/json" } })
  .then(async (res) => {
    if (!res.ok) throw new Error(`Config request failed (${res.status})`);
    const payload = await res.json();
    // /api/config uses camelCase names; the client reads UPPER_SNAKE ones. Assigning
    // the payload as-is added unused keys, so the server-side env settings never applied.
    const map = { playerColor: "PLAYER_COLOR", playerAutoplay: "PLAYER_AUTOPLAY", playerNextEpisode: "PLAYER_NEXT_EPISODE", playerEpisodeSelector: "PLAYER_EPISODE_SELECTOR" };
    for (const [from, to] of Object.entries(map)) if (payload[from] !== undefined) VIDORA_CONFIG[to] = payload[from];
  })
  .catch((err) => {
    console.warn("Vidora could not load server config; using local defaults.", err);
  });
