import { assertOriginAllowed } from './_lib/security.js';

// Client-safe settings only. Secrets and API keys stay server-side.
export default function handler(req, res) {
  if (!assertOriginAllowed(req)) return res.status(403).json({ error: 'Forbidden origin' });

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    demoMode: !process.env.TMDB_API_KEY,
    playerColor: process.env.PLAYER_COLOR || 'e8b84b',
    playerAutoplay: process.env.PLAYER_AUTOPLAY !== 'false',
    playerNextEpisode: process.env.PLAYER_NEXT_EPISODE !== 'false',
    playerEpisodeSelector: process.env.PLAYER_EPISODE_SELECTOR !== 'false',
    apiBase: '/api',
  });
}
