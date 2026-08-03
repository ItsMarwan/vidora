/**
 * VIDORA — DATA LAYER
 * Exposes one interface (VidoraData) that talks to YOUR OWN /api/tmdb
 * proxy (which holds the real TMDB key server-side). If the server has no
 * key configured, or a call fails for any reason, every method falls back
 * to the bundled demo catalog automatically — there's no separate
 * "demo mode" flag to manage on the client anymore, it's just what happens
 * when the live call doesn't work.
 */

const VidoraData = (() => {
  // ---------- image helpers ----------
  // TMDB's image CDN (image.tmdb.org) is public and doesn't need a key, so
  // building poster/backdrop URLs client-side is fine.
  function img(path, size = "w500") {
    if (!path) return placeholder("No Image");
    if (path.startsWith("http")) return path; // already absolute (demo mode)
    return `https://image.tmdb.org/t/p/${size}${path}`;
  }

  function placeholder(label, w = 500, h = 750, bg = "1e1e22", fg = "e8b84b") {
    return `https://placehold.co/${w}x${h}/${bg}/${fg}?text=${encodeURIComponent(label)}&font=raleway`;
  }

  // A poster/still that can NEVER fail to render, generated locally as an
  // inline SVG data URI. Used as the onerror fallback on every thumbnail.
  function localFallback(label, w = 500, h = 750) {
    const initial = (label || "?").trim().charAt(0).toUpperCase() || "?";
    const fontSize = Math.round(Math.min(w, h) * 0.34);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">`
      + `<rect width="100%" height="100%" fill="#1d1c22"/>`
      + `<text x="50%" y="53%" font-family="Georgia, 'Times New Roman', serif" font-style="italic" `
      + `font-size="${fontSize}" fill="#e8b84b" text-anchor="middle" dominant-baseline="middle">${initial}</text>`
      + `</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  // ---------- demo dataset ----------
  const demoMovies = [
    { id: 100101, title: "Marquee Nights", year: 2024, rating: 8.4, runtime: 118, genres: ["Drama", "Thriller"],
      overview: "A stagehand at a dying downtown cinema discovers the last reel in the projection booth holds more than film — it holds a decade-old secret the theater's owner has been trying to bury.", accent: "b23a48" },
    { id: 100102, title: "Static Horizon", year: 2023, rating: 7.9, runtime: 132, genres: ["Sci-Fi", "Action"],
      overview: "When Earth's satellites go dark in a single night, a decommissioned signal engineer is pulled back in to trace a transmission that shouldn't exist.", accent: "3a6ea5" },
    { id: 100103, title: "The Understudy", year: 2022, rating: 7.2, runtime: 104, genres: ["Drama"],
      overview: "Cast as the backup lead three days before opening night, a reluctant actor starts blurring the line between the role and himself.", accent: "6b4c93" },
    { id: 100104, title: "Low Tide", year: 2024, rating: 8.1, runtime: 121, genres: ["Mystery", "Thriller"],
      overview: "A coastal town's annual low tide reveals more than driftwood this year — and the detective who left ten years ago is the only one who remembers why that matters.", accent: "1f7a6c" },
    { id: 100105, title: "Paper Weather", year: 2021, rating: 7.6, runtime: 97, genres: ["Comedy", "Drama"],
      overview: "A failing weather-forecasting app founder starts predicting his own life falling apart with unsettling accuracy.", accent: "c98a2c" },
    { id: 100106, title: "Nine Red Doors", year: 2023, rating: 8.6, runtime: 140, genres: ["Mystery", "Thriller"],
      overview: "Nine estranged siblings are summoned to their late father's estate, where the will can only be read after every locked door is opened — in order.", accent: "8a2c3b" },
    { id: 100107, title: "Aftercurrent", year: 2020, rating: 7.4, runtime: 109, genres: ["Sci-Fi", "Drama"],
      overview: "A marine biologist studying a newly discovered current finds it's rewriting the migration patterns of everything it touches, including her.", accent: "2c6a8a" },
    { id: 100108, title: "The Long Intermission", year: 2019, rating: 7.0, runtime: 112, genres: ["Drama", "Comedy"],
      overview: "Twenty years after a touring production shut down mid-run, the original cast reunites to finally finish the last act.", accent: "9c6b2c" },
  ];

  const demoShows = [
    { id: 200201, title: "Cathode", year: 2023, rating: 8.7, genres: ["Sci-Fi", "Mystery"], accent: "3a6ea5",
      overview: "In a city where every household still runs on analog television, a repair technician starts finding broadcasts from stations that were shut down decades ago.",
      seasons: [
        { season_number: 1, name: "Season 1", episodes: eps(1, 8, "Cathode", "3a6ea5") },
        { season_number: 2, name: "Season 2", episodes: eps(2, 6, "Cathode", "3a6ea5") },
      ]},
    { id: 200202, title: "Understaffed", year: 2024, rating: 8.0, genres: ["Comedy"], accent: "c98a2c",
      overview: "The night crew at a 24-hour archive building holds the entire operation together while everyone above them takes the credit.",
      seasons: [
        { season_number: 1, name: "Season 1", episodes: eps(1, 10, "Understaffed", "c98a2c") },
      ]},
    { id: 200203, title: "The Ferryman's Ledger", year: 2022, rating: 8.9, genres: ["Drama", "Mystery"], accent: "6b4c93",
      overview: "A river-town ferry operator keeps a private ledger of everyone who's crossed and never come back — and the list is getting longer.",
      seasons: [
        { season_number: 1, name: "Season 1", episodes: eps(1, 8, "The Ferryman's Ledger", "6b4c93") },
        { season_number: 2, name: "Season 2", episodes: eps(2, 8, "The Ferryman's Ledger", "6b4c93") },
        { season_number: 3, name: "Season 3", episodes: eps(3, 5, "The Ferryman's Ledger", "6b4c93") },
      ]},
    { id: 200204, title: "Field Notes", year: 2021, rating: 7.5, genres: ["Drama", "Action"], accent: "1f7a6c",
      overview: "A disbanded wildfire response unit is called back for one last season none of them agreed to.",
      seasons: [
        { season_number: 1, name: "Season 1", episodes: eps(1, 6, "Field Notes", "1f7a6c") },
      ]},
    { id: 200205, title: "Nightshift Radio", year: 2024, rating: 7.8, genres: ["Drama", "Mystery"], accent: "b23a48",
      overview: "A late-night call-in host starts taking calls from a number that stopped being in service a year ago.",
      seasons: [
        { season_number: 1, name: "Season 1", episodes: eps(1, 8, "Nightshift Radio", "b23a48") },
      ]},
    { id: 200206, title: "The Substitute", year: 2023, rating: 7.3, genres: ["Comedy", "Drama"], accent: "8a2c3b",
      overview: "A substitute teacher keeps getting assigned to the same class, in the same room, for a school that closed down last spring.",
      seasons: [
        { season_number: 1, name: "Season 1", episodes: eps(1, 8, "The Substitute", "8a2c3b") },
      ]},
    { id: 200207, title: "Harbor Light", year: 2022, rating: 8.3, genres: ["Drama", "Action"], accent: "2c6a8a",
      overview: "A decommissioned lighthouse keeper refuses to leave her post even after the coast guard tells her the job no longer exists.",
      seasons: [
        { season_number: 1, name: "Season 1", episodes: eps(1, 7, "Harbor Light", "2c6a8a") },
        { season_number: 2, name: "Season 2", episodes: eps(2, 7, "Harbor Light", "2c6a8a") },
      ]},
    { id: 200208, title: "Overtime", year: 2021, rating: 7.6, genres: ["Comedy", "Sci-Fi"], accent: "9c6b2c",
      overview: "A minor-league referee starts noticing the clock never actually reaches zero in his games — and nobody else has noticed at all.",
      seasons: [
        { season_number: 1, name: "Season 1", episodes: eps(1, 6, "Overtime", "9c6b2c") },
      ]},
  ];

  function eps(season, count, showTitle, accent = "3a6ea5") {
    const titles = ["Static", "The Handoff", "Low Ground", "Every Other Tuesday", "What the Ledger Says",
      "Backfill", "No Signal", "Company Line", "Half Measures", "Sign-Off"];
    return Array.from({ length: count }, (_, i) => ({
      episode_number: i + 1,
      name: titles[i % titles.length],
      overview: `${showTitle} S${season}E${i + 1} — the crew deals with the fallout from last episode's decision, and it doesn't go the way anyone planned.`,
      runtime: 38 + (i % 4) * 3,
      still: placeholder(`S${season}E${i + 1}`, 300, 169, accent, "f2f0eb"),
    }));
  }

  function decorate(item, isShow) {
    return {
      ...item,
      poster: placeholder(item.title, 500, 750, item.accent, "f2f0eb"),
      backdrop: placeholder(item.title, 1280, 720, item.accent, "f2f0eb"),
      mediaType: isShow ? "tv" : "movie",
    };
  }

  const demoMoviesDecorated = demoMovies.map((m) => decorate(m, false));
  const demoShowsDecorated = demoShows.map((s) => decorate(s, true));

  // ---------- server proxy fetch helper ----------
  // Calls YOUR OWN /api/tmdb endpoint, passing the same relative path TMDB
  // itself would use as a ?path= query param (e.g. ?path=/movie/12345)
  // instead of appending it to the URL path. The real key is attached
  // server-side; this call carries none of it.
  async function tmdb(path, params = {}) {
    const url = new URL(`${location.origin}${VIDORA_CONFIG.API_BASE}/tmdb`);
    url.searchParams.set("path", path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Vidora API error ${res.status}`);
    return res.json();
  }

  // If the live call fails (no server-side key configured, TMDB rate
  // limit, offline, blocked request) we fall back to the bundled demo
  // catalog instead of leaving the caller's Promise rejected.
  async function tmdbOrDemoFallback(fetchFn, demoFallback) {
    try {
      return await fetchFn();
    } catch (err) {
      console.warn("Vidora: live TMDB request failed, falling back to demo data.", err);
      return demoFallback();
    }
  }

  // Looks up a YouTube trailer key via TMDB's /videos endpoint. Returns
  // null on any failure (including demo mode) — callers just hide the
  // trailer button in that case.
  async function videoKey(path) {
    try {
      const d = await tmdb(path);
      const vids = d.results || [];
      const best = vids.find((v) => v.site === "YouTube" && v.type === "Trailer") || vids.find((v) => v.site === "YouTube");
      return best ? best.key : null;
    } catch (err) {
      return null;
    }
  }

  function adaptMovie(m) {
    return {
      id: m.id, title: m.title, year: (m.release_date || "").slice(0, 4),
      rating: Math.round((m.vote_average || 0) * 10) / 10, overview: m.overview,
      poster: img(m.poster_path), backdrop: img(m.backdrop_path, "w1280"),
      genres: (m.genres || []).map((g) => g.name), runtime: m.runtime, mediaType: "movie",
    };
  }

  function adaptShow(s) {
    return {
      id: s.id, title: s.name, year: (s.first_air_date || "").slice(0, 4),
      rating: Math.round((s.vote_average || 0) * 10) / 10, overview: s.overview,
      poster: img(s.poster_path), backdrop: img(s.backdrop_path, "w1280"),
      genres: (s.genres || []).map((g) => g.name), mediaType: "tv",
      seasons: (s.seasons || []).filter((se) => se.season_number > 0),
    };
  }

  // ---------- public API ----------
  const api = {
    img, placeholder, localFallback,

    async trendingMovies() {
      return tmdbOrDemoFallback(
        async () => (await tmdb("/trending/movie/week")).results.map(adaptMovie),
        () => demoMoviesDecorated.slice(0, 8),
      );
    },
    async popularMovies() {
      return tmdbOrDemoFallback(
        async () => (await tmdb("/movie/popular")).results.map(adaptMovie),
        () => [...demoMoviesDecorated].reverse(),
      );
    },
    async topRatedMovies() {
      return tmdbOrDemoFallback(
        async () => (await tmdb("/movie/top_rated")).results.map(adaptMovie),
        () => [...demoMoviesDecorated].sort((a, b) => b.rating - a.rating),
      );
    },
    async trendingShows() {
      return tmdbOrDemoFallback(
        async () => (await tmdb("/trending/tv/week")).results.map(adaptShow),
        () => demoShowsDecorated.slice(0, 8),
      );
    },
    async popularShows() {
      return tmdbOrDemoFallback(
        async () => (await tmdb("/tv/popular")).results.map(adaptShow),
        () => [...demoShowsDecorated].reverse(),
      );
    },
    async topRatedShows() {
      return tmdbOrDemoFallback(
        async () => (await tmdb("/tv/top_rated")).results.map(adaptShow),
        () => [...demoShowsDecorated].sort((a, b) => b.rating - a.rating),
      );
    },
    async movieDetails(id) {
      return tmdbOrDemoFallback(
        async () => adaptMovie(await tmdb(`/movie/${id}`)),
        () => demoMoviesDecorated.find((m) => String(m.id) === String(id)),
      );
    },
    async showDetails(id) {
      return tmdbOrDemoFallback(
        async () => adaptShow(await tmdb(`/tv/${id}`)),
        () => demoShowsDecorated.find((s) => String(s.id) === String(id)),
      );
    },
    async seasonDetails(showId, seasonNumber) {
      return tmdbOrDemoFallback(
        async () => {
          const d = await tmdb(`/tv/${showId}/season/${seasonNumber}`);
          return {
            season_number: d.season_number, name: d.name,
            episodes: (d.episodes || []).map((e) => ({
              episode_number: e.episode_number, name: e.name, overview: e.overview,
              still: e.still_path ? img(e.still_path, "w300") : placeholder(e.name || "Episode", 300, 169),
              runtime: e.runtime,
            })),
          };
        },
        () => {
          const show = demoShowsDecorated.find((s) => String(s.id) === String(showId));
          return show && show.seasons.find((se) => se.season_number === Number(seasonNumber));
        },
      );
    },
    async search(query) {
      if (!query) return { movies: [], shows: [] };
      return tmdbOrDemoFallback(
        async () => {
          const d = await tmdb("/search/multi", { query });
          return {
            movies: d.results.filter((r) => r.media_type === "movie").map(adaptMovie),
            shows: d.results.filter((r) => r.media_type === "tv").map(adaptShow),
          };
        },
        () => {
          const q = query.toLowerCase();
          return {
            movies: demoMoviesDecorated.filter((m) => m.title.toLowerCase().includes(q)),
            shows: demoShowsDecorated.filter((s) => s.title.toLowerCase().includes(q)),
          };
        },
      );
    },
  };

  // Picks a random movie or show from a broad-ish pool ("Surprise Me").
  api.randomTitle = async function randomTitle() {
    const [tm, ts, pm, ps] = await Promise.all([
      api.trendingMovies(), api.trendingShows(), api.popularMovies(), api.popularShows(),
    ]);
    const pool = [...tm, ...ts, ...pm, ...ps];
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  };

  // Finds other titles of the SAME media type sharing at least one genre
  // with `item`, for the "More Like This" row.
  api.relatedTitles = async function relatedTitles(item) {
    if (!item) return [];
    const pool = item.mediaType === "tv"
      ? [...(await api.trendingShows()), ...(await api.popularShows()), ...(await api.topRatedShows())]
      : [...(await api.trendingMovies()), ...(await api.popularMovies()), ...(await api.topRatedMovies())];
    const genres = new Set(item.genres || []);
    const seen = new Set([String(item.id)]);
    const related = [];
    for (const candidate of pool) {
      const key = String(candidate.id);
      if (seen.has(key)) continue;
      seen.add(key);
      if ((candidate.genres || []).some((g) => genres.has(g))) related.push(candidate);
    }
    return related.slice(0, 8);
  };

  api.movieTrailerKey = (id) => videoKey(`/movie/${id}/videos`);
  api.showTrailerKey = (id) => videoKey(`/tv/${id}/videos`);

  return api;
})();
