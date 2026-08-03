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
  VIDKING_BASE_URL: "https://www.vidking.net/embed",
  PLAYER_COLOR: "e8b84b",
  PLAYER_AUTOPLAY: true,
  PLAYER_NEXT_EPISODE: true,
  PLAYER_EPISODE_SELECTOR: true,
  PROGRESS_SAVE_INTERVAL_MS: 120000,
};

window.VIDORA_CONFIG = VIDORA_CONFIG;

fetch("/api/config", { headers: { Accept: "application/json" } })
  .then(async (res) => {
    if (!res.ok) throw new Error(`Config request failed (${res.status})`);
    const payload = await res.json();
    Object.assign(VIDORA_CONFIG, payload);
  })
  .catch((err) => {
    console.warn("Vidora could not load server config; using local defaults.", err);
  });
