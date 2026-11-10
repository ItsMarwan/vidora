# Vidora

Vidora is a polished, mobile-friendly streaming front end for browsing movies and series, watching them through the Vidy embed player, and sharing watch sessions with friends through Watch Party.

It supports clean URLs, a local profile system, continue-watching progress, search, favorites, and a fully client-side router so deep links work properly.

## What’s included

- Home page with featured hero content and content rows
- Movies and Series browsing views
- Movie and series detail pages
- Watch pages for movie playback and episode playback
- Search across movies and series
- Local profile support with name and avatar
- My List / favorites
- Continue Watching progress
- Watch Party rooms with host/guest sync
- Responsive layout for desktop and mobile

## Run locally

There is no build step.

Options:

- Open [index.html](index.html) directly in a browser
- Or serve the project locally with a static server:

```bash
npx serve .
```

or:

```bash
python3 -m http.server 3000
```

A lightweight Node dev server is also included:

```bash
npm run dev
```

## Use real TMDB data

The app can run in demo mode first, but to use live content you need a TMDB API key.

1. Get a free TMDB v3 API key from https://www.themoviedb.org/settings/api
2. Open [js/config.js](js/config.js)
3. Paste your key into the TMDB config value
4. Reload the app

If no key is configured, the app falls back to a built-in demo catalog so you can still explore the UI.

## Why TMDB

Vidy uses TMDB IDs for playback URLs, so Vidora uses TMDB for both metadata and embed playback. That keeps browsing and player URLs aligned without extra mapping logic.

## Project structure

```text
vidora/
  index.html                Shell page with navbar, mobile menu, and app mount
  css/styles.css            Global styles, layout, and component styling
  js/config.js              TMDB configuration
  js/data.js                Data layer with TMDB fetches and demo fallback
  js/player.js              Embed URLs, player-event stream, watch progress / Continue Watching
  js/stage.js               The playback surface: embed iframe or native player, behind one sync() API
  js/components.js           Modal, dropdown, toast, and UI helpers
  js/party.js               Watch Party client: polling, host state, presence, session resume
  js/party-ui.js            Watch Party UI + how a guest follows the host
  extension/src/mediaplayer.js  The Vidora <video> player (extension + page), speaks the player protocol
  js/profile.js             Local profile storage and export/import helpers
  js/profile-ui.js          Profile page UI
  js/app.js                 Router, rendering, and app navigation
  api/                      Vercel/serverless API helpers for config and proxying
  vercel.json               Vercel rewrites and headers for SPA routing
```

## Features in more detail

### Navigation and routing

The app uses a client-side router with clean URLs such as:

- /movies
- /series
- /movie/123
- /watch/movie/123
- /watch/series/123/1/2
- /profile

The Vercel config rewrites these routes to the single-page app entry point so direct links and refreshed pages work.

### Profile system

A local profile is stored in the browser and supports:

- name and avatar
- profile edits and deletion
- export/import of saved data
- integration with Watch Party identity and navbar avatar updates

### Continue Watching

Watch progress is saved in local storage and surfaced in the home page as a Continue Watching row.

### Watch Party

Watch Party is server-relayed (no WebRTC): rooms live in KV behind `/api/party`, and every participant polls it. The host's player reports `{ event, currentTime, duration, playing }`; guests receive it with a server timestamp and project the host's position forward, so joining mid-movie or a slow poll still lands on the right second.

How it works:

- The host opens a watch page and creates a room (code + password)
- Guests join from the invite link; the host controls play, pause and seek
- Refreshing the tab rejoins the party (the session token is kept in `sessionStorage`)
- The room ends when the host presses **End party** (or after the 4 hour idle TTL)

**It works with two kinds of player**, through one small abstraction (`js/stage.js`):

| Player | How a guest follows the host |
| --- | --- |
| Embed iframe (Vidy / URPlayer) | The iframe can't be controlled, so it is reloaded at the right position — only on host commands or large drift, never for a heartbeat. |
| **Vidora media player** (`extension/src/mediaplayer.js`) | The player is simply *told* to seek/play/pause over `postMessage` — no reload, no re-buffering, drift corrected in place. |

The media player is the same file the browser extension injects; `index.html` also loads it so the page can drive it directly (`VidoraStage.playNative()`). Both speak the protocol documented at the top of `mediaplayer.js`: `PLAYER_EVENT` out (same shape the embeds emit), `VIDORA_PLAYER_CMD` in, plus `READY`/`STATUS` announcements. When the extension replaces the iframe, the stage notices the player's `READY` message and switches the whole party over to live sync automatically. If the browser blocks an autoplay sync, the player shows a "Tap to join the party" button.

### Playback progress

Progress is written from one place (`js/player.js`) for the title that is actually on screen. The saved resume point is never overwritten by the first seconds of a fresh load, follows an embed's own "next episode" button, and the player isn't loaded until the "Resume where you left off?" prompt is answered.

## Deployment

The project is designed for Vercel.

The deployment setup includes:

- SPA-style rewrites for deep links
- static asset serving
- no-store cache headers for API routes
- a fallback 404 page for unmatched routes

## Notes

- The app is intentionally front-end focused and does not rely on a server-side database for profile or watch progress data.
- Most user state is stored locally in the browser.
- For production use, make sure your environment and API configuration are set correctly before deploying.

