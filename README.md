# Vidora [beta]

A clean, modern, mobile-responsive front end for browsing movies & series and
playing them through the Vidking embed player you provided.

## Running it

No build step. Either:

- Open `index.html` directly in a browser, or
- Serve the folder with any static server, e.g.:
  ```
  npx serve .
  ```
  (or `python3 -m http.server` from inside the `vidora` folder)

## Going live (adding your API key)

Right now the site runs in **demo mode** with a small built-in catalog so you
can click through every screen — home, movies, series, movie detail, season
and episode picker, and the player itself — before you have an API key.

To switch to real data:

1. Get a free TMDB v3 API key: https://www.themoviedb.org/settings/api
2. Open `js/config.js`
3. Paste the key into `TMDB_API_KEY: ""`
4. Reload — demo mode turns off automatically and every page starts pulling
   live TMDB data.

## Why TMDB, not IMDB

The Vidking player you gave me takes **TMDB IDs** in its URLs
(`/embed/movie/{tmdbId}`, `/embed/tv/{tmdbId}/{season}/{episode}`), not IMDB
IDs. So Vidora uses TMDB for both browsing metadata (titles, posters,
seasons/episodes) and for building the player URLs — the same ID is used for
both, which keeps everything in sync with zero extra mapping.

## Structure

```
vidora/
  index.html            shell: navbar + app mount point
  css/styles.css         design tokens + all component styles
  js/config.js            <-- put your TMDB key here
  js/data.js               data layer (TMDB fetches + demo fallback)
  js/player.js              builds Vidking URLs, tracks watch progress
  js/components.js          custom dropdown / modal / toast
  js/party.js                Watch Party networking (PeerJS)
  js/party-ui.js               Watch Party screens & host/guest panels
  js/app.js                     router + page rendering
```

## Features

- Home page with a featured hero, Continue Watching, Trending, Popular and
  Top Rated rows
- Movies and Series tabs with genre filtering
- Movie detail page with a Play button straight into the Vidking player
- Series detail page with a season dropdown (custom component) and full
  episode list, each episode playable individually
- Watch progress is captured from the player's `postMessage` events and
  saved to `localStorage`, powering the Continue Watching row
- Search across movies and series
- **Watch Party**: on any watch page, click "Start a Watch Party" to get a
  shareable link + password. Friends open the link, enter the password, and
  land in the same movie/episode. Only the host's playback controls matter —
  guests' players are kept in sync with the host's play/pause/seek.
- Custom UI components throughout — dropdowns, modals, toasts, buttons —
  no native `<select>` / `alert()` anywhere
- Fully responsive down to small phones, with tuned custom scrollbars

## How Watch Party actually works (read this before demoing it)

There's no backend — rooms are peer-to-peer over WebRTC using PeerJS's free
public broker for signaling only (no account or key needed). That means:

- **Both people need the site open at the same time.** The host's browser
  tab *is* the room — if they close it, the room ends.
- Vidking's embed only documents *outgoing* events (play/pause/seeked/
  timeupdate) — there's no documented way to remotely command play/pause
  inside someone else's iframe. So sync works by reloading the guest's
  iframe with a matching `progress` (and `autoPlay`) value whenever the host
  plays, pauses, or seeks. It's a close, workable approximation — not
  frame-perfect remote control — with a brief reload/flicker each time it
  resyncs.
- The password is just a shared secret to keep randoms out of the room, not
  encryption.

