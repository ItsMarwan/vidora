# Vidora

Vidora is a polished, mobile-friendly streaming front end for browsing movies and series, watching them through the Vidking embed player, and sharing watch sessions with friends through Watch Party.

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

Vidking uses TMDB IDs for playback URLs, so Vidora uses TMDB for both metadata and embed playback. That keeps browsing and player URLs aligned without extra mapping logic.

## Project structure

```text
vidora/
  index.html                Shell page with navbar, mobile menu, and app mount
  css/styles.css            Global styles, layout, and component styling
  js/config.js              TMDB configuration
  js/data.js                Data layer with TMDB fetches and demo fallback
  js/player.js              Player URL generation and watch progress handling
  js/components.js           Modal, dropdown, toast, and UI helpers
  js/party.js               Watch Party networking logic
  js/party-ui.js            Watch Party UI screens and join/host panels
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

Watch Party uses PeerJS over WebRTC for room-based sync.

How it works:

- The host opens a watch page and creates a room
- A guest joins with the room code/password
- The host’s playback state is mirrored to the guest as closely as possible
- The room ends when the host closes the tab

> Watch Party is a best-effort sync experience rather than full frame-perfect remote control, since the embed player only exposes limited playback events.

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

