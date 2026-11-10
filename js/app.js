/**
 * VIDORA — APP
 * Tiny History-API router + render functions. No build step, no framework.
 * URLs are now clean (/movie/123, /watch/series/1/2/3, …) instead of
 * hash-based (#/movie/123). vercel.json rewrites every non-/api path to
 * index.html so a hard refresh or shared link on any of these routes
 * still works — this file then reads location.pathname and renders.
 */

const app = document.getElementById("app");
const redirectedPath = sessionStorage.getItem("vidora_redirect_path");

if (redirectedPath) {
    sessionStorage.removeItem("vidora_redirect_path");

    history.replaceState({}, "", redirectedPath);
}

// ---------------- global redirect guard + internal link routing ----------------
(() => {
  function isBlockableUrl(url) {
    try {
      const u = new URL(url, location.href);
      if (u.protocol === 'mailto:' || u.protocol === 'tel:') return false;
      return u.origin !== location.origin;
    } catch (err) {
      return false;
    }
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a');
    // If a recent row drag just happened, suppress navigation for anchors
    // inside the horizontal `.row-scroll` so dragging a card doesn't
    // accidentally follow its link.
    try {
      if (typeof rowDragJustMoved !== 'undefined' && rowDragJustMoved && a && a.closest && a.closest('.row-scroll')) {
        rowDragJustMoved = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    } catch (err) {}
    if (!a || !a.href) return;

    if (isBlockableUrl(a.href)) {
      e.preventDefault();
      console.warn('Blocked external navigation to', a.href);
      try { if (window.VD && VD.toast) VD.toast('Blocked external redirect'); } catch (e) {}
      return;
    }

    // Same-origin link: route it client-side instead of a full page reload,
    // unless the person is trying to open it in a new tab/window or it's a
    // download link — those should behave like a normal <a>.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target && a.target !== '' && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    let u;
    try { u = new URL(a.href, location.href); } catch { return; }
    if (u.origin !== location.origin) return;
    // A same-page #fragment link (the "Skip to content" link) is just an
    // in-page jump. It used to be routed like a navigation, which re-rendered
    // the page — on a watch page that restarted the player.
    if (u.hash && u.pathname === location.pathname && u.search === location.search) return;
    e.preventDefault();
    navigate(u.pathname + u.search);
  }, true);

  document.addEventListener('submit', (e) => {
    const form = e.target;
    const action = form.getAttribute && form.getAttribute('action') || location.href;
    if (isBlockableUrl(action)) {
      e.preventDefault();
      console.warn('Blocked external form submit to', action);
      try { if (window.VD && VD.toast) VD.toast('Blocked external redirect'); } catch (e) {}
    }
  }, true);

  const origOpen = window.open.bind(window);
  window.open = function(url, name, specs) {
    if (url && isBlockableUrl(url)) {
      console.warn('Blocked window.open to', url);
      try { if (window.VD && VD.toast) VD.toast('Blocked external popup'); } catch (e) {}
      return null;
    }
    return origOpen(url, name, specs);
  };

  try {
    const loc = window.location;
    const origAssign = loc.assign.bind(loc);
    const origReplace = loc.replace.bind(loc);
    loc.assign = function(url) {
      if (isBlockableUrl(url)) { console.warn('Blocked location.assign to', url); return; }
      return origAssign(url);
    };
    loc.replace = function(url) {
      if (isBlockableUrl(url)) { console.warn('Blocked location.replace to', url); return; }
      return origReplace(url);
    };
  } catch (err) {
    console.warn('Could not override location.assign/replace', err);
  }

  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes || []) {
        if (n && n.querySelectorAll) {
          const anchors = n.querySelectorAll('a[href]');
          anchors.forEach((a) => a.addEventListener('click', (e) => {
            if (isBlockableUrl(a.href)) { e.preventDefault(); console.warn('Blocked external navigation to', a.href); }
          }));
        }
      }
    }
  });
  mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();

// ---------------- client-side navigation (History API) ----------------
// `function` declarations are hoisted, so the click handler installed
// above (which runs before this point textually) can still call these —
// by the time a click actually happens, they're fully defined.
let internalNavCount = 0;
function navigate(path) {
  if (location.pathname + location.search === path) { route(); return; }
  history.pushState({}, "", path);
  internalNavCount++;
  route();
}
// Exposed so party-ui.js (a separate module) can navigate without a hash.
window.vidoraNavigate = navigate;

function goBack(fallbackPath) {
  // If we got here via our own client-side navigation this session, a real
  // browser "back" takes you somewhere sensible inside the app. If this
  // page was opened fresh (e.g. a shared link), fall back to a known route
  // instead of risking a jump off-site to whatever referred here.
  if (internalNavCount > 0) history.back();
  else navigate(fallbackPath);
}

window.addEventListener("popstate", () => route());

// ---------------- shared bits ----------------

// Escapes text for BOTH attribute values and element content. It used to
// escape only & and ", so a title like "Foo <3" (or anything reflected from
// the URL / a party host) could break out of its markup.
function escAttr(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------- My List (favorites) ----------------
const VD_LIST_KEY = "vidora_my_list";

function readMyList() {
  try { return JSON.parse(localStorage.getItem(VD_LIST_KEY)) || {}; } catch { return {}; }
}
function writeMyList(list) {
  localStorage.setItem(VD_LIST_KEY, JSON.stringify(list));
}
function myListKey(mediaType, id) {
  return `${mediaType}-${id}`;
}
function isInMyList(mediaType, id) {
  return !!readMyList()[myListKey(mediaType, id)];
}
function getMyList() {
  return Object.values(readMyList()).sort((a, b) => b.addedAt - a.addedAt);
}
function toggleMyList(item) {
  const list = readMyList();
  const key = myListKey(item.mediaType, item.id);
  if (list[key]) {
    delete list[key];
  } else {
    list[key] = {
      id: item.id, mediaType: item.mediaType, title: item.title, poster: item.poster,
      year: item.year, rating: item.rating, genres: item.genres, addedAt: Date.now(),
    };
  }
  writeMyList(list);
  return !!list[key];
}

function favButtonHTML(item, { compact = false } = {}) {
  const fav = isInMyList(item.mediaType, item.id);
  const dataItem = escAttr(JSON.stringify({
    id: item.id, mediaType: item.mediaType, title: item.title, poster: item.poster,
    year: item.year, rating: item.rating, genres: item.genres,
  }));
  if (compact) {
    return `<button type="button" class="card-fav-btn${fav ? " active" : ""}" data-item="${dataItem}" aria-pressed="${fav}" aria-label="${fav ? "Remove from My List" : "Add to My List"}">${VD.icon(fav ? "heartFilled" : "heart", { size: 16 })}</button>`;
  }
  return `<button type="button" class="btn btn-ghost fav-btn${fav ? " active" : ""}" data-item="${dataItem}" aria-pressed="${fav}">${VD.icon(fav ? "heartFilled" : "heart", { size: 16 })} ${fav ? "In My List" : "Add to My List"}</button>`;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".card-fav-btn, .fav-btn");
  if (!btn) return;
  e.preventDefault();
  let item;
  try { item = JSON.parse(btn.dataset.item); } catch { return; }
  const nowFav = toggleMyList(item);
  document.querySelectorAll(".card-fav-btn[data-item], .fav-btn[data-item]").forEach((b) => {
    let bi;
    try { bi = JSON.parse(b.dataset.item); } catch { return; }
    if (String(bi.id) !== String(item.id) || bi.mediaType !== item.mediaType) return;
    b.classList.toggle("active", nowFav);
    b.setAttribute("aria-pressed", String(nowFav));
    if (b.classList.contains("card-fav-btn")) {
      b.innerHTML = VD.icon(nowFav ? "heartFilled" : "heart", { size: 16 });
      b.setAttribute("aria-label", nowFav ? "Remove from My List" : "Add to My List");
    } else {
      b.innerHTML = `${VD.icon(nowFav ? "heartFilled" : "heart", { size: 16 })} ${nowFav ? "In My List" : "Add to My List"}`;
    }
  });
  VD.toast(nowFav ? `Added “${item.title}” to My List` : `Removed “${item.title}” from My List`);
});

document.addEventListener("error", (e) => {
  const img = e.target;
  if (!img || img.tagName !== "IMG" || !img.classList || !img.classList.contains("vd-thumb")) return;
  if (img.dataset.fallbackApplied) return;
  img.dataset.fallbackApplied = "1";
  const w = img.dataset.fallbackW ? Number(img.dataset.fallbackW) : 500;
  const h = img.dataset.fallbackH ? Number(img.dataset.fallbackH) : 750;
  img.src = VidoraData.localFallback(img.dataset.fallbackTitle || img.alt, w, h);
}, true);

function thumbImg(src, title, { w = 500, h = 750, cls = "", loading = "lazy" } = {}) {
  const safeTitle = escAttr(title);
  const finalSrc = src ? escAttr(src) : VidoraData.localFallback(title, w, h);
  return `<img class="vd-thumb${cls ? " " + cls : ""}" src="${finalSrc}" alt="${safeTitle}" data-fallback-title="${safeTitle}" data-fallback-w="${w}" data-fallback-h="${h}" loading="${loading}" />`;
}

function starRow(rating) {
  return `<span class="rating">${VD.icon("starFilled", { size: 13 })} ${rating ?? "—"}</span>`;
}

// ---------------- Share ----------------
async function shareTitle(item) {
  const url = `${location.origin}/${item.mediaType === "tv" ? "series" : "movie"}/${item.id}`;
  if (navigator.share) {
    try { await navigator.share({ title: item.title, text: `Watch “${item.title}” on Vidora`, url }); }
    catch (err) { /* user cancelled the share sheet — not an error */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    VD.toast("Link copied to clipboard");
  } catch (err) {
    VD.toast("Couldn't copy the link");
  }
}

function shareButtonHTML() {
  return `<button type="button" class="btn btn-ghost share-btn" id="detailShareBtn">${VD.icon("share", { size: 16 })} Share</button>`;
}

function trailerButtonHTML() {
  return `<button type="button" class="btn btn-outline trailer-btn" id="detailTrailerBtn" hidden>${VD.icon("clapper", { size: 16 })} Watch Trailer</button>`;
}

function wireDetailActions(container, item, trailerKeyPromise, token) {
  const shareBtn = container.querySelector("#detailShareBtn");
  if (shareBtn) shareBtn.addEventListener("click", () => shareTitle(item));

  const trailerBtn = container.querySelector("#detailTrailerBtn");
  if (!trailerBtn) return;
  trailerKeyPromise.then((key) => {
    if (token !== routeToken || !key) return;
    trailerBtn.hidden = false;
    trailerBtn.addEventListener("click", () => {
      VD.modal({
        title: `${escAttr(item.title)} — Trailer`,
        wide: true,
        bodyHTML: `<div class="trailer-frame-wrap"><iframe src="https://www.youtube.com/embed/${key}?autoplay=1" title="${escAttr(item.title)} trailer" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`,
        actions: [{ id: "close", label: "Close", variant: "btn-ghost", onClick: (close) => close() }],
      });
    });
  });
}

async function paintRelatedRow(container, item, token) {
  const related = await VidoraData.relatedTitles(item);
  if (token !== routeToken || !related.length) return;
  container.innerHTML = rowSection("More like this", "", related);
  wireRowScrollers(container);
}

function card(item) {
  const progress = item.mediaType === "movie"
    ? VidoraPlayer.getProgress(item.id, "movie")
    : (item.season && item.episode ? VidoraPlayer.getProgress(item.id, "tv", item.season, item.episode) : null);
  const bar = progress
    ? `<div class="card-progress"><span style="width:${Math.min(progress.progress * 100, 100)}%"></span></div>`
    : "";
  const href = item.resumeHref
    ? item.resumeHref
    : item.mediaType === "tv" ? `/series/${item.id}` : `/movie/${item.id}`;
  const metaLine = item.season && item.episode
    ? `S${item.season}E${item.episode}`
    : `${item.year || ""}${item.rating ? ` · ${VD.icon("starFilled", { size: 11 })} ${item.rating}` : ""}`;
  return `
    <a class="card" href="${href}">
      <div class="card-poster-wrap">
        ${thumbImg(item.poster, item.title, { w: 500, h: 750 })}
        ${item.certification ? `<span class="card-cert">${escAttr(item.certification)}</span>` : ""}
        ${bar}
        ${favButtonHTML(item, { compact: true })}
      </div>
      <div class="card-title">${escAttr(item.title)}</div>
      <div class="card-meta">${metaLine}</div>
    </a>`;
}

function rowSection(title, sub, items) {
  if (!items || !items.length) return "";
  return `
    <section class="section">
      <div class="wrap">
        <div class="section-head">
          <h2 class="section-title">${title}</h2>
          ${sub ? `<span class="section-sub">${escAttr(sub)}</span>` : ""}
        </div>
      </div>
      <div class="row-scroll-wrap">
        <button type="button" class="row-nav-btn row-nav-prev" aria-label="Scroll left">${VD.icon("chevronLeft", { size: 18 })}</button>
        <div class="row-scroll">${items.map(card).join("")}</div>
        <button type="button" class="row-nav-btn row-nav-next" aria-label="Scroll right">${VD.icon("chevronRight", { size: 18 })}</button>
      </div>
    </section>`;
}

// ---------------- hero: one featured title ----------------
// A hero that rotates by itself moves the thing you were about to click, so
// this one never advances on its own: one title, picked per day, with its
// words on the ground and its artwork in a frame (nothing sits on a photo).
function heroBlock(item, { enter = false } = {}) {
  if (!item) return "";
  const isTv = item.mediaType === "tv";
  const href = isTv ? `/series/${item.id}` : `/movie/${item.id}`;
  const playHref = isTv ? href : `/watch/movie/${item.id}`;
  const seasons = isTv && item.seasons ? item.seasons.length : 0;
  return `
    <section class="hero${enter ? " is-entering" : ""}" id="heroSection" aria-labelledby="heroTitle">
      <div class="wrap hero-grid">
        <div class="hero-copy">
          <span class="pill">Featured ${isTv ? "series" : "film"}</span>
          <h1 class="hero-title" id="heroTitle">${escAttr(item.title)}</h1>
          <div class="hero-meta">
            ${starRow(item.rating)}
            ${item.year ? `<span>${escAttr(item.year)}</span>` : ""}
            ${item.runtime ? `<span>${item.runtime} min</span>` : ""}
            ${seasons ? `<span>${seasons} season${seasons > 1 ? "s" : ""}</span>` : ""}
          </div>
          <p class="hero-overview">${escAttr(item.overview || "")}</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="${playHref}">${VD.icon("playFilled", { size: 16 })} ${isTv ? "View episodes" : "Play movie"}</a>
            <a class="btn btn-ghost" href="${href}">More info</a>
          </div>
        </div>
        <a class="hero-media" href="${href}" tabindex="-1" aria-hidden="true">${thumbImg(item.backdrop, item.title, { w: 1280, h: 720, loading: "eager" })}</a>
      </div>
    </section>`;
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Bumped on every route() call so slow/late responses from a page the
// person already navigated away from get dropped instead of clobbering
// whatever's actually on screen.
let routeToken = 0;

function backBar(label, fallbackPath) {
  return `<div class="page-back-row"><button type="button" class="back-btn" data-fallback="${fallbackPath}">${VD.icon("arrowLeft", { size: 15 })} ${label}</button></div>`;
}

function wireBackButtons(container) {
  container.querySelectorAll("[data-fallback]").forEach((btn) => {
    btn.addEventListener("click", () => goBack(btn.dataset.fallback));
  });
}

// ---------------- card row: nav buttons + click-drag scrolling ----------------
let rowDrag = null;
let rowDragJustMoved = false;

window.addEventListener("mousemove", (e) => {
  if (!rowDrag) return;
  const dx = e.pageX - rowDrag.startX;
  const dy = e.pageY - (rowDrag.startY || 0);
  if (Math.abs(dx) > 6 || Math.abs(dy) > 6) rowDrag.moved = true;
  rowDrag.track.scrollLeft = rowDrag.startScroll - dx;
});
window.addEventListener("mouseup", () => {
  if (!rowDrag) return;
  rowDrag.track.classList.remove("dragging");
  rowDragJustMoved = rowDrag.moved;
  rowDrag = null;
});

// Listen for movie pick events dispatched from the browser extension
window.addEventListener("message", async (event) => {
  // Only the page itself (or the extension acting as it) may steer the
  // router. Embed iframes post messages to this window too - they must not
  // be able to navigate the app.
  if (event.source !== window) return;
  if (!event.data || event.data.type !== "VIDORA_SELECT_MOVIE") return;

  const { tmdbId, watch = false } = event.data;
  if (!tmdbId) return;

  // Route to either detail page or watch mode with the fresh TMDB ID
  const targetPath = watch ? `/watch/movie/${tmdbId}` : `/movie/${tmdbId}`;
  navigate(targetPath);
});

// Helper method exposed globally for direct extension script calls
window.selectMovieFromExtension = function(tmdbId, watch = false) {
  const targetPath = watch ? `/watch/movie/${tmdbId}` : `/movie/${tmdbId}`;
  navigate(targetPath);
};

let rowScrollerCleanups = [];
function teardownRowScrollers() {
  rowScrollerCleanups.forEach((fn) => { try { fn(); } catch (err) {} });
  rowScrollerCleanups = [];
}

function wireRowScrollers(container) {
  teardownRowScrollers();
  container.querySelectorAll(".row-scroll-wrap").forEach((wrap) => {
    const track = wrap.querySelector(".row-scroll");
    const prevBtn = wrap.querySelector(".row-nav-prev");
    const nextBtn = wrap.querySelector(".row-nav-next");
    if (!track) return;

    function updateButtons() {
      const max = track.scrollWidth - track.clientWidth - 1;
      if (prevBtn) prevBtn.disabled = track.scrollLeft <= 0;
      if (nextBtn) nextBtn.disabled = max <= 0 || track.scrollLeft >= max;
    }
    if (prevBtn) prevBtn.addEventListener("click", () => track.scrollBy({ left: -track.clientWidth * 0.85, behavior: "smooth" }));
    if (nextBtn) nextBtn.addEventListener("click", () => track.scrollBy({ left: track.clientWidth * 0.85, behavior: "smooth" }));
    track.addEventListener("scroll", updateButtons, { passive: true });
    updateButtons();

    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => updateButtons());
      ro.observe(track);
    } else {
      window.addEventListener("resize", updateButtons);
    }
    const needsLoadListener = document.readyState !== "complete";
    if (needsLoadListener) window.addEventListener("load", updateButtons, { once: true });

    rowScrollerCleanups.push(() => {
      if (ro) ro.disconnect();
      window.removeEventListener("resize", updateButtons);
      if (needsLoadListener) window.removeEventListener("load", updateButtons);
    });

    track.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      rowDrag = { track, startX: e.pageX, startY: e.pageY, startScroll: track.scrollLeft, moved: false };
      track.classList.add("dragging");
    });
    track.addEventListener("click", (e) => {
      if (rowDragJustMoved) {
        rowDragJustMoved = false;
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
  });
}

// Static placeholders in the shape of what's coming: calm, nothing sweeps or
// blinks, and the page doesn't jump when the real content lands.
function loadingState(kind = "rows") {
  const cards = Array.from({ length: 10 }, () => `<div class="sk sk-card"></div>`).join("");
  const hero = kind === "home"
    ? `<div class="sk-hero">
         <div class="sk-lines">
           <div class="sk sk-line" style="width:120px"></div>
           <div class="sk sk-line" style="height:64px;width:92%"></div>
           <div class="sk sk-line" style="width:56%"></div>
           <div class="sk sk-line" style="height:96px"></div>
         </div>
         <div class="sk sk-media"></div>
       </div>`
    : "";
  const inner = `<span class="sr-only">Loading…</span>${hero}<div class="sk sk-title"></div><div class="sk-row">${cards}</div>`;
  return kind === "inline"
    ? `<div role="status" aria-live="polite">${inner}</div>`
    : `<div class="wrap sk-page" role="status" aria-live="polite">${inner}</div>`;
}

function emptyState(title, sub, buttonLabel) {
  return `<div class="empty-state"><div class="empty-state-icon" aria-hidden="true">${VD.icon("search", { size: 28 })}</div><h3>${title}</h3><p>${sub}</p>${buttonLabel ? `<button class="btn btn-primary empty-state-btn" type="button" onclick="window.vidoraNavigate('/')">${buttonLabel}</button>` : ""}</div>`;
}

// ---------------- pages ----------------

async function renderHome(token) {
  app.innerHTML = loadingState("home");
  const [trendingMovies, popularMovies, trendingShows, topRated] = await Promise.all([
    VidoraData.trendingMovies(), VidoraData.popularMovies(),
    VidoraData.trendingShows(), VidoraData.topRatedMovies(),
  ]);
  if (token !== routeToken) return;

  // One featured title, changing daily rather than on a timer.
  const pool = [...trendingMovies.slice(0, 3), ...trendingShows.slice(0, 2)];
  if (!pool.length) pool.push(...popularMovies.slice(0, 3));
  const featured = pool.length ? pool[Math.floor(Date.now() / 86400000) % pool.length] : null;

  // The hero's entrance plays once per visit, not on every return to Home.
  let enter = false;
  try {
    enter = !sessionStorage.getItem("vidora_hero_entered");
    sessionStorage.setItem("vidora_hero_entered", "1");
  } catch { /* storage unavailable: just skip the entrance */ }

  const cw = VidoraPlayer.getContinueWatching();
  const cwItems = cw.map((c) => ({
    id: c.id, title: c.title, mediaType: c.mediaType, poster: c.poster,
    year: "", rating: null, season: c.season, episode: c.episode,
    resumeHref: c.mediaType === "tv"
      ? `/watch/series/${c.id}/${c.season}/${c.episode}`
      : `/watch/movie/${c.id}`,
  }));

  app.innerHTML = `
    ${heroBlock(featured, { enter })}
    ${rowSection("Continue watching", "Pick up where you left off", cwItems)}
    ${rowSection("My List", "Saved for later", getMyList())}
    ${rowSection("Trending movies", "", trendingMovies)}
    ${rowSection("Trending series", "", trendingShows)}
    ${rowSection("Popular movies", "", popularMovies)}
    ${rowSection("Top rated", "", topRated)}
  `;
  wireRowScrollers(app);
}

function gridSkeleton() {
  return Array.from({ length: 12 }, () => `<div class="sk sk-card" style="flex:none;width:auto"></div>`).join("");
}

async function renderGrid(kind, token) {
  const noun = kind === "movies" ? "movie" : "series";
  app.innerHTML = `
    <div class="wrap">
      <div class="grid-page-head">
        ${backBar("Back", "/")}
        <h1 class="grid-page-title">${kind === "movies" ? "Movies" : "Series"}</h1>
        <p class="grid-page-desc">${kind === "movies" ? "Everything from new releases to all-time favorites." : "Full seasons, ready whenever you are."}</p>
        <div class="chip-row" id="genreChips" role="group" aria-label="Filter by genre"></div>
        <p class="result-count" id="gridCount" aria-live="polite"></p>
      </div>
      <div class="poster-grid" id="gridItems"><span class="sr-only" role="status">Loading…</span>${gridSkeleton()}</div>
    </div>`;
  wireBackButtons(app);

  const [a, b, c] = kind === "movies"
    ? await Promise.all([VidoraData.trendingMovies(), VidoraData.popularMovies(), VidoraData.topRatedMovies()])
    : await Promise.all([VidoraData.trendingShows(), VidoraData.popularShows(), VidoraData.topRatedShows()]);
  if (token !== routeToken) return;

  const map = new Map();
  [...a, ...b, ...c].forEach((it) => map.set(it.id, it));
  const items = [...map.values()];
  const genres = [...new Set(items.flatMap((i) => i.genres || []))].sort();

  const chips = document.getElementById("genreChips");
  chips.innerHTML = ["All", ...genres].map((g, i) =>
    `<button class="chip${i === 0 ? " active" : ""}" type="button" data-genre="${escAttr(g)}" aria-pressed="${i === 0}">${escAttr(g)}</button>`).join("");

  function paint(genre) {
    const filtered = genre === "All" ? items : items.filter((i) => (i.genres || []).includes(genre));
    document.getElementById("gridItems").innerHTML = filtered.length
      ? filtered.map(card).join("")
      : emptyState("Nothing here yet", "Try a different genre.");
    document.getElementById("gridCount").textContent =
      `${filtered.length} ${noun === "movie" ? "movie" : "series"}${filtered.length === 1 ? "" : noun === "movie" ? "s" : ""}${genre === "All" ? "" : ` in ${genre}`}`;
  }
  paint("All");
  chips.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    chips.querySelectorAll(".chip").forEach((c2) => { c2.classList.remove("active"); c2.setAttribute("aria-pressed", "false"); });
    btn.classList.add("active");
    btn.setAttribute("aria-pressed", "true");
    paint(btn.dataset.genre);
  });
}

function renderMyList() {
  const items = getMyList();
  app.innerHTML = `
    <div class="wrap">
      <div class="grid-page-head">
        ${backBar("Back", "/")}
        <h1 class="grid-page-title">My List</h1>
        <p class="grid-page-desc">Titles you've saved to watch later. Tap the heart on any poster to add or remove one.</p>
        ${items.length ? `<p class="result-count">${items.length} saved</p>` : ""}
      </div>
      ${items.length
        ? `<div class="poster-grid">${items.map(card).join("")}</div>`
        : emptyState("Your list is empty", "Tap the heart on any movie or series to save it here.", "Browse titles")}
    </div>`;
  wireBackButtons(app);
}

async function renderProfile(token) {
  if (token !== routeToken) return;
  ProfileUI.renderPage(app);
}

const legalPages = {
  terms: {
    title: 'Terms of Service',
    intro: 'These terms govern use of Vidora. By browsing content, you agree to use this site responsibly and accept that Vidora is a directory interface, not a content host.',
    sections: [
      {
        heading: 'Service overview',
        body: 'Vidora provides a lightweight front-end for discovering movies and series. The site does not host or distribute media. Playback is provided by external embed providers such as Vidy and URPlayer.',
      },
      {
        heading: 'User obligations',
        body: 'Use Vidora for lawful, personal entertainment. Do not attempt to modify, scrape, or republish the site in a way that infringes intellectual property rights or harms the service.',
      },
      {
        heading: 'Availability',
        body: 'Content availability and playback quality depend on third-party sources. Vidora does not guarantee that any title will remain accessible or free of interruptions.',
      },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    intro: 'Vidora is designed to minimize data collection. This policy explains what is stored locally and how the site uses that information.',
    sections: [
      {
        heading: 'What we store',
        body: 'Vidora stores only browser-local preferences such as search history, favorites, and language settings. No user accounts or personal profiles are required.',
      },
      {
        heading: 'No tracking',
        body: 'The app does not include analytics, tracking cookies, or third-party advertising scripts. Search suggestions and watch history are generated locally from available metadata.',
      },
      {
        heading: 'External services',
        body: 'Playback links and external embeds may be served by third-party providers. Those providers may have their own privacy practices that are outside Vidora’s control.',
      },
    ],
  },
  disclaimer: {
    title: 'Content Disclaimer',
    intro: 'Vidora is an informational browsing tool for movies and shows. It does not own or license the underlying media content.',
    sections: [
      {
        heading: 'No ownership claim',
        body: 'All program names, artwork, and trademarks remain the property of their respective rights holders. Vidora only surfaces metadata and links for discovery purposes.',
      },
      {
        heading: 'Use at your own risk',
        body: 'External playback providers may change, remove, or restrict access to media at any time. Vidora is not responsible for third-party content availability or legality in your location.',
      },
      {
        heading: 'Accuracy of information',
        body: 'Metadata such as ratings, descriptions, and artwork are provided by TMDB and may not always be complete or up to date.',
      },
    ],
  },
  copyright: {
    title: 'Copyright',
    intro: 'Vidora respects copyright and intellectual property. This page explains ownership and your responsibilities when using the service.',
    sections: [
      {
        heading: 'Intellectual property',
        body: 'All films, series, images, titles, and descriptions displayed on Vidora are copyrighted by their owners. Vidora only displays metadata for discovery purposes.',
      },
      {
        heading: 'DMCA and takedown',
        body: 'If you believe any content or metadata on Vidora infringes your copyright, contact the site owner so it can be reviewed and removed if appropriate.',
      },
    ],
  },
  hosting: {
    title: 'Hosting',
    intro: 'Vidora is hosted as a lightweight web app and relies on a small proxy backend for TMDB requests. This page describes hosting and server behavior.',
    sections: [
      {
        heading: 'Platform',
        body: 'Vidora is served as a static site with a minimal API proxy for TMDB. The front-end runs entirely in the browser after the page loads.',
      },
      {
        heading: 'Server data',
        body: 'The backend only forwards requests to TMDB and does not store personal user data. The app itself does not collect or retain identifiable information.',
      },
      {
        heading: 'External providers',
        body: 'Playback is handled by external embed providers. Their hosting, content delivery, and privacy practices are separate from Vidora.',
      },
    ],
  },
};

async function renderLegalPage(page, token) {
  if (token !== routeToken) return;
  if (!app.innerHTML.trim()) {
    await renderHome(token);
    if (token !== routeToken) return;
  }
  const pageData = legalPages[page];
  const bodyHTML = `<div class="legal-modal-body">${pageData
    ? pageData.sections.map((section) => `
        <section>
          <h2>${section.heading}</h2>
          <p>${section.body}</p>
        </section>
      `).join('')
    : `<p>The requested legal page does not exist. Use the footer links to open Terms, Privacy, Disclaimer, Copyright, or Hosting.</p>`}
  </div>`;

  VD.modal({
    title: pageData ? pageData.title : 'Legal information',
    sub: pageData ? pageData.intro : 'No legal page found.',
    bodyHTML,
    wide: true,
    actions: [
      { id: 'close', label: 'Close', variant: 'btn-primary', onClick: (close) => close() },
    ],
  });
}

async function renderMovieDetail(id, token) {
  app.innerHTML = loadingState();
  const m = await VidoraData.movieDetails(id);
  if (token !== routeToken) return;
  if (!m) {
    app.innerHTML = emptyState("Not found", "That title isn't available.", "Go home");
    return;
  }

  // Set the browser tab title dynamically from TMDB data
  document.title = `${m.title}${m.year ? ` (${m.year})` : ""} - Vidora`;

  // The main action says where you'll land: a saved spot turns "Play" into "Resume".
  const at = resumePoint(VidoraPlayer.getProgress(id, "movie"));
  const playLabel = at !== null ? `Resume at ${clockLabel(at)}` : "Play movie";

  app.innerHTML = `
    <div class="wrap detail-top">${backBar("Back", "/movies")}</div>
    <div class="wrap detail-body">
      <div class="detail-poster">${thumbImg(m.poster, m.title, { w: 500, h: 750, loading: "eager" })}</div>
      <div class="detail-main">
        <h1 class="detail-title">${escAttr(m.title)}</h1>
        <div class="detail-meta">
          ${starRow(m.rating)}
          ${m.year ? `<span>${escAttr(m.year)}</span>` : ""}
          ${m.runtime ? `<span>${m.runtime} min</span>` : ""}
          ${m.certification ? `<span class="cert-badge">${escAttr(m.certification)}</span>` : ""}
        </div>
        ${(m.genres || []).length ? `<div class="genre-tags">${m.genres.map((g) => `<span class="genre-tag">${escAttr(g)}</span>`).join("")}</div>` : ""}
        <p class="detail-overview">${escAttr(m.overview || "")}</p>
        ${m.certificationDescription ? `<p class="detail-rating-desc">${escAttr(m.certificationDescription)}</p>` : ""}
        ${m.guideUrl ? `<a class="detail-guide-link" href="${escAttr(m.guideUrl)}" target="_blank" rel="noopener">IMDb parental guide</a>` : ""}
        <div class="detail-actions">
          <a class="btn btn-primary" href="/watch/movie/${m.id}">${VD.icon("playFilled", { size: 16 })} ${playLabel}</a>
          ${trailerButtonHTML()}
          ${favButtonHTML(m)}
          ${shareButtonHTML()}
        </div>
      </div>
    </div>
    <div id="relatedRow"></div>`;

  wireBackButtons(app);
  wireDetailActions(app, m, VidoraData.movieTrailerKey(m.id), token);
  paintRelatedRow(document.getElementById("relatedRow"), m, token);
}

async function renderSeriesDetail(id, seasonParam, token) {
  app.innerHTML = loadingState();
  const s = await VidoraData.showDetails(id);
  if (token !== routeToken) return;
  if (!s) { app.innerHTML = emptyState("Not found", "That title isn't available.", "Go home"); return; }
  const seasonNum = Number(seasonParam) || s.seasons[0]?.season_number || 1;
  const season = await VidoraData.seasonDetails(id, seasonNum);
  if (token !== routeToken) return;
  if (!season) { app.innerHTML = emptyState("Not found", "That season isn't available.", "Go home"); return; }
  document.title = `${s.title} - Vidora`;

  // Continue where you left off in this show, else start the season.
  const last = VidoraPlayer.getContinueWatching().find((c) => c.mediaType === "tv" && String(c.id) === String(id));
  const firstEp = season.episodes[0]?.episode_number || 1;
  const playHref = last ? `/watch/series/${id}/${last.season}/${last.episode}` : `/watch/series/${id}/${seasonNum}/${firstEp}`;
  const playLabel = last ? `Continue S${last.season} E${last.episode}` : `Play season ${seasonNum}`;

  app.innerHTML = `
    <div class="wrap detail-top">${backBar("Back", "/series")}</div>
    <div class="wrap detail-body">
      <div class="detail-poster">${thumbImg(s.poster, s.title, { w: 500, h: 750, loading: "eager" })}</div>
      <div class="detail-main">
        <h1 class="detail-title">${escAttr(s.title)}</h1>
        <div class="detail-meta">
          ${starRow(s.rating)}
          ${s.year ? `<span>${escAttr(s.year)}</span>` : ""}
          <span>${s.seasons.length} season${s.seasons.length > 1 ? "s" : ""}</span>
          ${s.certification ? `<span class="cert-badge">${escAttr(s.certification)}</span>` : ""}
        </div>
        ${(s.genres || []).length ? `<div class="genre-tags">${s.genres.map((g) => `<span class="genre-tag">${escAttr(g)}</span>`).join("")}</div>` : ""}
        <p class="detail-overview">${escAttr(s.overview || "")}</p>
        ${s.certificationDescription ? `<p class="detail-rating-desc">${escAttr(s.certificationDescription)}</p>` : ""}
        ${s.guideUrl ? `<a class="detail-guide-link" href="${escAttr(s.guideUrl)}" target="_blank" rel="noopener">IMDb parental guide</a>` : ""}
        <div class="detail-actions">
          <a class="btn btn-primary" href="${playHref}">${VD.icon("playFilled", { size: 16 })} ${playLabel}</a>
          ${trailerButtonHTML()}
          ${favButtonHTML(s)}
          ${shareButtonHTML()}
        </div>

        <div class="season-picker">
          <span id="seasonPickerLabel">Season</span>
          <div id="seasonDropdown"></div>
        </div>

        <div class="episode-list" id="episodeList">
          ${season.episodes.map((e) => `
            <a class="episode-row" href="/watch/series/${id}/${seasonNum}/${e.episode_number}" aria-label="Play episode ${e.episode_number}: ${escAttr(e.name)}">
              <div class="episode-num">${e.episode_number}</div>
              <div class="episode-thumb">${thumbImg(e.still, `${s.title} — ${e.name}`, { w: 300, h: 169 })}</div>
              <div>
                <div class="episode-name">${escAttr(e.name)}</div>
                <div class="episode-overview">${escAttr(e.overview || "")}</div>
              </div>
              <span class="episode-runtime">${e.runtime ? e.runtime + " min" : ""}</span>
              <span class="episode-play" aria-hidden="true">${VD.icon("playFilled", { size: 14 })}</span>
            </a>`).join("")}
        </div>
      </div>
    </div>
    <div id="relatedRow"></div>`;
  wireBackButtons(app);

  VD.dropdown({
    mount: document.getElementById("seasonDropdown"),
    options: s.seasons.map((se) => ({ value: se.season_number, label: se.name || `Season ${se.season_number}` })),
    selected: seasonNum,
    ariaLabel: "Select season",
    onChange: (value) => { navigate(`/series/${id}/${value}`); },
  });
  wireDetailActions(app, s, VidoraData.showTrailerKey(id), token);
  paintRelatedRow(document.getElementById("relatedRow"), s, token);
}

// Overview block under the player.
function playerDetailsBlock(item) {
  const meta = [
    item.rating != null ? starRow(item.rating) : "",
    item.year ? `<span>${escAttr(item.year)}</span>` : "",
    item.certification ? `<span class="cert-badge">${escAttr(item.certification)}</span>` : "",
    item.runtime ? `<span>${item.runtime} min</span>` : "",
  ].filter(Boolean).join("");
  if (!meta && !(item.genres || []).length && !item.overview) return "";
  return `
    <div class="player-details">
      <div class="player-details-main">
        ${meta ? `<div class="detail-meta" style="margin-top:0">${meta}</div>` : ""}
        ${(item.genres || []).length ? `<div class="genre-tags">${item.genres.map((g) => `<span class="genre-tag">${escAttr(g)}</span>`).join("")}</div>` : ""}
        ${item.overview ? `<p class="player-overview">${escAttr(item.overview)}</p>` : ""}
      </div>
    </div>`;
}

// ---------------- watch pages ----------------
// Everything a watch page sets up that must be undone when the person
// leaves it: the playback stage (and any native player in it), the party
// panel, progress tracking, and a still-open resume prompt. route() calls
// this before every navigation. Previously nothing was torn down, so the
// previous page's listeners, player and tracked title lived on.
let watchCleanup = null;
function teardownWatch() {
  if (!watchCleanup) return;
  const fn = watchCleanup;
  watchCleanup = null;
  try { fn(); } catch (err) { console.error(err); }
}

const RESUME_MIN_SECONDS = 15;

function resumePoint(progress) {
  if (!progress || !progress.currentTime || progress.currentTime < RESUME_MIN_SECONDS) return null;
  if (progress.duration && progress.progress >= 0.95) return null;
  return progress.currentTime;
}

function clockLabel(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

// Same identity rule PartyUI uses to decide whether the party is on this page.
function sameWatchMedia(meta, w) {
  if (!meta || meta.mediaType !== w.mediaType || String(meta.id) !== String(w.id)) return false;
  if (w.mediaType === "tv") return String(meta.season) === String(w.season) && String(meta.episode) === String(w.episode);
  return true;
}

// Decides where playback STARTS and then starts it.
//
// The player is not loaded until the question is answered. It used to load
// from 0:00 (and autoplay) behind the "Resume where you left off?" prompt
// and only jump when the person clicked — so playback visibly snapped back
// to the saved spot partway through whatever they'd already started
// watching, and the Resume button silently did nothing at all once the
// iframe was swapped out for the player shim.
//
// Returns a function that closes a still-open prompt (for teardown).
function startPlayback(stage, { party, progress }) {
  // Watching along with a party: start where the host IS (projected to
  // now), never at a saved spot of our own. With no host state yet, wait
  // paused rather than playing ahead of the host.
  if (party) {
    const pos = VidoraParty.getHostPosition();
    if (pos && !pos.ended) stage.loadIframe(pos.time, pos.playing);
    else stage.loadIframe(0, false);
    return () => {};
  }

  const at = resumePoint(progress);
  if (at === null) { stage.loadIframe(0, true); return () => {}; }

  let answered = false;
  const choose = (time) => { if (answered) return; answered = true; stage.loadIframe(time, true); };
  const label = clockLabel(at);
  const m = VD.modal({
    title: "Resume where you left off?",
    sub: `You were at ${label}.`,
    // ✕ / Esc / clicking outside = "no preference" = start from the top
    onDismiss: () => choose(0),
    actions: [
      { id: "restart", label: "Start over", variant: "btn-ghost", onClick: (close) => { close(); choose(0); } },
      { id: "resume", label: `Resume at ${label}`, variant: "btn-primary", onClick: (close) => { close(); choose(at); } },
    ],
  });
  return () => { answered = true; m.close(); };
}

// Shared by the movie and episode watch pages.
//   watch: { mediaType, id, season?, episode?, title, poster }
//   buildUrl(w, time, autoplay): the embed URL for the current w
function mountWatchPlayer(watch, buildUrl, hooks = {}) {
  const w = { ...watch }; // mutable: an embed's own "next episode" button changes season/episode
  const party = VidoraParty.isGuest() && sameWatchMedia(VidoraParty.getMediaMeta(), w);
  const progress = VidoraPlayer.getProgress(w.id, w.mediaType, w.season, w.episode);

  const stage = VidoraStage.create({
    container: document.getElementById("vidoraStage"),
    buildIframeUrl: (t, autoplay) => buildUrl(w, t, autoplay),
    title: w.title,
  });

  VidoraPlayer.init(
    { id: w.id, title: w.title, mediaType: w.mediaType, poster: w.poster, season: w.season, episode: w.episode },
    {
      onMetaChange: (m) => {
        w.season = m.season; w.episode = m.episode;
        history.replaceState({}, "", `/watch/series/${w.id}/${w.season}/${w.episode}`);
        document.title = `S${w.season}E${w.episode} - ${w.title} - Vidora`;
        PartyUI.updateContext({ season: w.season, episode: w.episode });
        if (hooks.onMetaChange) hooks.onMetaChange(w);
      },
    },
  );

  PartyUI.mount(document.getElementById("partyContainer"), { ...w, stage });
  const closePrompt = startPlayback(stage, { party, progress });

  watchCleanup = () => {
    closePrompt();
    PartyUI.unmount();
    VidoraPlayer.stop();
    VidoraStage.teardown();
  };
}

async function renderWatchMovie(id, token) {
  app.innerHTML = loadingState();
  const m = await VidoraData.movieDetails(id);
  if (token !== routeToken) return;
  if (!m) { app.innerHTML = emptyState("Not found", "That title isn't available.", "Go home"); return; }
  document.title = `${m.title} - Vidora`;

  app.innerHTML = `
    <div class="wrap player-page">
      <div class="player-topbar">
        <a class="player-back" href="/movie/${id}">${VD.icon("arrowLeft", { size: 16 })} Back</a>
        <div class="player-heading">
          <h1 class="player-title">${escAttr(m.title)}</h1>
        </div>
      </div>
      <div class="watch-grid">
        <div class="watch-main"><div class="player-frame-wrap" id="vidoraStage"></div></div>
      </div>
      <div id="partyContainer"></div>
      ${playerDetailsBlock(m)}
    </div>`;

  mountWatchPlayer(
    { mediaType: "movie", id, title: m.title, poster: m.poster },
    (w, t, autoplay) => VidoraPlayer.movieUrl(w.id, t, autoplay),
  );
}

async function renderWatchSeries(id, season, episode, token) {
  app.innerHTML = loadingState();
  const [s, se] = await Promise.all([VidoraData.showDetails(id), VidoraData.seasonDetails(id, season)]);
  if (token !== routeToken) return;
  if (!s) { app.innerHTML = emptyState("Not found", "That title isn't available.", "Go home"); return; }
  document.title = `S${season}E${episode} - ${s.title} - Vidora`;

  // `se` is undefined when the season can't be loaded (offline, or an id
  // that isn't in the demo catalog).
  const episodes = se && se.episodes ? se.episodes : [];
  const epHref = (n) => `/watch/series/${id}/${season}/${n}`;
  const byNumber = (n) => episodes.find((e) => e.episode_number === Number(n));
  const cur = byNumber(episode);
  const subText = (n) => `Season ${season} · Episode ${n}${byNumber(n) ? ` — ${byNumber(n).name}` : ""}`;

  const sideRows = episodes.map((e) => {
    const pr = VidoraPlayer.getProgress(id, "tv", season, e.episode_number);
    const pct = pr && pr.progress > 0.02 && pr.progress < 0.95 ? Math.round(pr.progress * 100) : 0;
    return `
      <a class="side-ep" href="${epHref(e.episode_number)}"${e.episode_number === Number(episode) ? ' aria-current="true"' : ""}>
        <span class="side-ep-num">${e.episode_number}</span>
        <span class="side-ep-name">${escAttr(e.name)}</span>
        <span class="side-ep-time">${e.runtime ? `${e.runtime} min` : ""}</span>
        ${pct ? `<span class="side-ep-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>` : ""}
      </a>`;
  }).join("");

  const side = episodes.length ? `
    <aside class="watch-side" aria-label="Episodes">
      <div class="watch-side-inner">
        <div class="watch-side-head">
          <h2>Season ${escAttr(season)}</h2>
          <p>${episodes.length} episode${episodes.length === 1 ? "" : "s"}</p>
        </div>
        <nav class="side-list" id="sideList" aria-label="Episodes in season ${escAttr(season)}">${sideRows}</nav>
      </div>
    </aside>` : "";

  app.innerHTML = `
    <div class="wrap player-page">
      <div class="player-topbar">
        <a class="player-back" href="/series/${id}/${season}">${VD.icon("arrowLeft", { size: 16 })} Episodes</a>
        <div class="player-heading">
          <h1 class="player-title">${escAttr(s.title)}</h1>
          <p class="player-sub" id="playerSub">${escAttr(subText(episode))}</p>
        </div>
        <div class="player-nav">
          <a class="btn btn-ghost btn-sm" id="epPrev" href="#" hidden>${VD.icon("chevronLeft", { size: 14 })} Previous</a>
          <a class="btn btn-ghost btn-sm" id="epNext" href="#" hidden>Next ${VD.icon("chevronRight", { size: 14 })}</a>
        </div>
      </div>
      <div class="watch-grid${side ? " has-side" : ""}">
        <div class="watch-main"><div class="player-frame-wrap" id="vidoraStage"></div></div>
        ${side}
      </div>
      <div id="partyContainer"></div>
      ${playerDetailsBlock({ rating: s.rating, year: s.year, genres: s.genres, runtime: cur && cur.runtime, overview: (cur && cur.overview) || s.overview })}
    </div>`;

  // Previous / next episode, and the "now playing" marker in the list. Also
  // re-run when an embed's own next-episode button moves to another episode.
  function paintEpisodeChrome(n) {
    n = Number(n);
    const prev = byNumber(n - 1), next = byNumber(n + 1);
    const prevEl = document.getElementById("epPrev"), nextEl = document.getElementById("epNext");
    if (prevEl) { prevEl.hidden = !prev; if (prev) prevEl.href = epHref(prev.episode_number); }
    if (nextEl) { nextEl.hidden = !next; if (next) nextEl.href = epHref(next.episode_number); }
    const sub = document.getElementById("playerSub");
    if (sub) sub.textContent = subText(n);
    const list = document.getElementById("sideList");
    if (!list) return;
    list.querySelectorAll(".side-ep").forEach((a) => {
      const here = a.getAttribute("href") === epHref(n);
      if (here) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
    });
    // keep the current episode in view inside the list WITHOUT scrolling the page
    const active = list.querySelector('[aria-current="true"]');
    if (active) list.scrollTop = Math.max(0, active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2);
  }
  paintEpisodeChrome(episode);

  mountWatchPlayer(
    { mediaType: "tv", id, season: String(season), episode: String(episode), title: s.title, poster: s.poster },
    (w, t, autoplay) => VidoraPlayer.tvUrl(w.id, w.season, w.episode, t, autoplay),
    { onMetaChange: (w) => paintEpisodeChrome(w.episode) },
  );
}

async function renderSearch(query, token) {
  saveRecentSearch(query);
  app.innerHTML = `
    <div class="wrap search-page">
      <div class="grid-page-head">
        <h1 class="grid-page-title">Results for “${escAttr(query)}”</h1>
        <div class="chip-row" id="searchChips" role="group" aria-label="Filter results" hidden></div>
      </div>
      <div id="searchResults">${loadingState("inline")}</div>
    </div>`;
  const { movies, shows } = await VidoraData.search(query);
  if (token !== routeToken) return;
  const el = document.getElementById("searchResults");
  if (!movies.length && !shows.length) {
    el.innerHTML = emptyState("No matches", "Check the spelling, or try a shorter title or a different keyword.");
    return;
  }

  const chips = document.getElementById("searchChips");
  function paint(which) {
    const showMovies = movies.length && which !== "series";
    const showShows = shows.length && which !== "movies";
    el.innerHTML = `
      ${showMovies ? `<section class="search-group"><h2>Movies <span class="muted">${movies.length}</span></h2><div class="poster-grid">${movies.map(card).join("")}</div></section>` : ""}
      ${showShows ? `<section class="search-group"><h2>Series <span class="muted">${shows.length}</span></h2><div class="poster-grid">${shows.map(card).join("")}</div></section>` : ""}`;
  }
  // The filter only earns its place when there is something to filter.
  if (movies.length && shows.length) {
    chips.hidden = false;
    chips.innerHTML = [["all", `All ${movies.length + shows.length}`], ["movies", `Movies ${movies.length}`], ["series", `Series ${shows.length}`]]
      .map(([v, label], i) => `<button type="button" class="chip${i === 0 ? " active" : ""}" data-which="${v}" aria-pressed="${i === 0}">${label}</button>`).join("");
    chips.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;
      chips.querySelectorAll(".chip").forEach((c) => { c.classList.remove("active"); c.setAttribute("aria-pressed", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
      paint(btn.dataset.which);
    });
  }
  paint("all");
}

// ---------------- router ----------------

const routeDefinitions = [
  { pattern: "/watch/series/:id/:season/:episode", nav: "", render: ({ id, season, episode }, token) => renderWatchSeries(id, season, episode, token) },
  { pattern: "/watch/movie/:id", nav: "", render: ({ id }, token) => renderWatchMovie(id, token) },
  { pattern: "/series/:id/:season", nav: "series", render: ({ id, season }, token) => renderSeriesDetail(id, season, token) },
  { pattern: "/series/:id", nav: "series", render: ({ id }, token) => renderSeriesDetail(id, null, token) },
  { pattern: "/movie/:id", nav: "", render: ({ id }, token) => renderMovieDetail(id, token) },
  { pattern: "/search/:query", nav: "", render: ({ query }, token) => renderSearch(query, token) },
  { pattern: "/legal/:page", nav: "", modal: true, render: ({ page }, token) => renderLegalPage(page, token) },
  { pattern: "/party/:id", nav: "", render: ({ id }) => PartyUI.renderJoinPage(app, id) },
  { pattern: "/series", nav: "series", render: (_params, token) => renderGrid("series", token) },
  { pattern: "/movies", nav: "movies", render: (_params, token) => renderGrid("movies", token) },
  { pattern: "/list", nav: "list", render: () => renderMyList() },
  { pattern: "/profile", nav: "profile", render: (_params, token) => renderProfile(token) },
  { pattern: "/home", nav: "home", render: (_params, token) => renderHome(token) },
  { pattern: "/", nav: "home", render: (_params, token) => renderHome(token) },
];

function normalizePath(path) {
  const raw = path instanceof URL ? path.pathname : String(path || "");
  const urlPath = raw.startsWith("/") ? raw : new URL(raw, location.href).pathname;
  const collapsed = urlPath.replace(/\/\/+/g, "/").replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

function compileRoute(route) {
  const pattern = normalizePath(route.pattern);
  const keys = [];
  const regexSource = pattern === "/"
    ? "/"
    : pattern.replace(/:([^/]+)/g, (_, key) => {
        keys.push(key);
        return "([^/]+)";
      });
  return { ...route, pattern, keys, regex: new RegExp(`^${regexSource}$`) };
}

const routeTable = routeDefinitions.map(compileRoute);

function matchRoute(pathname) {
  const normalized = normalizePath(pathname);
  for (const route of routeTable) {
    const match = normalized.match(route.regex);
    if (!match) continue;
    const params = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    return { route, params };
  }
  return null;
}

function setActiveNav(routeName) {
  document.querySelectorAll(".nav-links a, .mobile-menu-links a, .tabbar a").forEach((a) => {
    const isActive = a.dataset.route === routeName;
    a.classList.toggle("active", isActive);
    if (isActive) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function playPageTransition() {
  app.classList.remove("page-anim");
  void app.offsetWidth;
  app.classList.add("page-anim");
}

async function route() {
  teardownWatch(); // stop the previous watch page's player/party/tracking before anything else
  const myToken = ++routeToken;
  const matched = matchRoute(location.pathname);
  if (!matched || !matched.route.modal) window.scrollTo(0, 0);
  closeMobileMenu();
  playPageTransition();

  setActiveNav(matched ? matched.route.nav : "");

  try {
    if (!matched) {
      app.innerHTML = emptyState("Page not found", "Let's get you back home.", "Go home");
      return;
    }
    await matched.route.render(matched.params, myToken);
  } catch (err) {
    console.error(err);
    app.innerHTML = emptyState("Something went wrong", "Please try again in a moment.");
  }
}

// ---------------- chrome: search, mobile nav ----------------

let surpriseInFlight = false;
async function goSurpriseMe() {
  if (surpriseInFlight) return;
  surpriseInFlight = true;
  VD.toast("Finding something to watch…");
  try {
    const pick = await VidoraData.randomTitle();
    if (!pick) { VD.toast("Couldn't find anything right now — try again in a moment."); return; }
    navigate(pick.mediaType === "tv" ? `/series/${pick.id}` : `/movie/${pick.id}`);
  } catch (err) {
    console.error(err);
    VD.toast("Couldn't find anything right now — try again in a moment.");
  } finally {
    surpriseInFlight = false;
  }
}

// Recent searches: shown when the empty search box is focused, so getting
// back to something you looked for is one tap instead of retyping it.
const RECENT_KEY = "vidora_recent_searches";
function getRecentSearches() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, 6) : [];
  } catch { return []; }
}
function saveRecentSearch(q) {
  const term = String(q || "").trim();
  if (!term) return;
  try {
    const list = [term, ...getRecentSearches().filter((x) => x.toLowerCase() !== term.toLowerCase())].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage unavailable */ }
}
function clearRecentSearches() {
  try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ }
}

function wireSearchInput(input) {
  if (!input) return;

  const wrap = input.parentElement;
  let sugEl = wrap.querySelector(".search-suggestions");
  if (!sugEl) {
    sugEl = document.createElement("div");
    sugEl.className = "search-suggestions";
    sugEl.style.display = "none";
    wrap.appendChild(sugEl);
  }
  sugEl.id = `${input.id}Listbox`;
  sugEl.setAttribute("role", "listbox");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", sugEl.id);
  input.setAttribute("aria-expanded", "false");

  let suggestions = [];
  let activeIndex = -1;
  let lastQuery = "";

  function hide() {
    suggestions = [];
    activeIndex = -1;
    sugEl.style.display = "none";
    sugEl.innerHTML = "";
    input.setAttribute("aria-expanded", "false");
  }

  function show(items, headHTML = "") {
    suggestions = items;
    activeIndex = -1;
    if (!items.length && !headHTML) { hide(); return; }
    sugEl.innerHTML = headHTML + items.map((s, i) => s.recent
      ? `<div class="suggestion-item" role="option" data-index="${i}" data-href="${escAttr(s.href)}">
           <span class="suggestion-glyph" aria-hidden="true">${VD.icon("clock", { size: 18 })}</span>
           <div class="suggestion-copy"><span class="suggestion-title">${escAttr(s.title)}</span></div>
         </div>`
      : `<div class="suggestion-item" role="option" data-index="${i}" data-href="${escAttr(s.href)}">
           <img class="suggestion-thumb" src="${escAttr(s.image)}" alt="" loading="lazy" />
           <div class="suggestion-copy">
             <span class="suggestion-title">${escAttr(s.title)}</span>
             <span class="suggestion-meta">${escAttr(s.type)}${s.year ? ` · ${escAttr(s.year)}` : ""}</span>
           </div>
         </div>`).join("");
    sugEl.style.display = "";
    input.setAttribute("aria-expanded", "true");
  }

  function showRecent() {
    const recent = getRecentSearches();
    if (!recent.length) { hide(); return; }
    show(
      recent.map((q) => ({ recent: true, title: q, href: `/search/${encodeURIComponent(q)}` })),
      `<div class="suggestion-head"><span>Recent searches</span><button type="button" data-clear>Clear</button></div>`,
    );
  }

  function setActive(i) {
    const items = sugEl.querySelectorAll(".suggestion-item");
    items.forEach((it) => it.classList.remove("active"));
    if (i >= 0 && items[i]) {
      items[i].classList.add("active");
      items[i].scrollIntoView({ block: "nearest" });
      activeIndex = i;
    } else {
      activeIndex = -1;
    }
  }

  // Debounced search
  let debounceTimer = null;
  function scheduleQuery(q) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      const val = (q || "").trim();
      if (!val) { showRecent(); return; }
      lastQuery = val;
      try {
        const res = await VidoraData.search(val);
        // Merge movies and shows, prioritise movies then shows, limit 8
        const items = [...(res.movies || []), ...(res.shows || [])].slice(0, 8).map((it) => ({
          title: it.title || it.name || "",
          year: it.year || "",
          href: it.mediaType === "tv" ? `/series/${it.id}` : `/movie/${it.id}`,
          type: it.mediaType === "tv" ? "Series" : "Movie",
          image: it.poster || it.backdrop || VidoraData.placeholder(it.title || it.name || "Title", 80, 120),
        }));
        // Only render if the query hasn't changed meanwhile
        if (lastQuery !== val) return;
        if (items.length) show(items);
        else show([], `<div class="suggestion-head"><span>No matches for “${escAttr(val)}”</span></div>`);
      } catch (err) {
        console.error("Search suggestions failed", err);
        hide();
      }
    }, 200);
  }

  input.addEventListener("input", () => scheduleQuery(input.value));
  input.addEventListener("focus", () => { if (!input.value.trim()) showRecent(); });

  // Keyboard navigation
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, suggestions.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      if (activeIndex >= 0 && suggestions[activeIndex]) {
        e.preventDefault();
        closeMobileMenu();
        navigate(suggestions[activeIndex].href);
        hide();
        input.blur();
      } else if (input.value.trim()) {
        closeMobileMenu();
        navigate(`/search/${encodeURIComponent(input.value.trim())}`);
        hide();
        input.blur();
      }
      return;
    }
    if (e.key === "Escape") {
      if (sugEl.style.display !== "none") { hide(); e.stopPropagation(); }
      else input.blur();
    }
  });

  // Click on a suggestion / recent search / the Clear control
  sugEl.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-clear]")) { clearRecentSearches(); hide(); return; }
    const item = ev.target.closest(".suggestion-item");
    if (!item) return;
    const href = item.dataset.href;
    if (href) {
      closeMobileMenu();
      navigate(href);
      hide();
    }
  });

  // Mouseover to set active
  sugEl.addEventListener("mousemove", (ev) => {
    const item = ev.target.closest(".suggestion-item");
    if (!item) return;
    const i = Number(item.dataset.index);
    if (!Number.isNaN(i)) setActive(i);
  });

  // Click outside to close
  document.addEventListener("click", (ev) => {
    if (!wrap.contains(ev.target)) hide();
  });
}
wireSearchInput(document.getElementById("searchInput"));
wireSearchInput(document.getElementById("mobileSearchInput"));

document.getElementById("navSurprise").addEventListener("click", goSurpriseMe);
document.getElementById("mobileSurprise").addEventListener("click", () => {
  closeMobileMenu();
  goSurpriseMe();
});

// ---------------- chrome: profile button ----------------
// Shows a generic person icon until a local profile exists, then swaps to
// the profile's photo (or stays on the icon if no photo was set). Kept in
// sync live via VidoraProfile.onChange so saving/editing/deleting a
// profile updates the navbar immediately, without a route change.
function updateNavProfileButton() {
  const profile = VidoraProfile.getProfile();

  const btn = document.getElementById("navProfile");
  if (btn) {
    if (profile && profile.image) {
      btn.innerHTML = `<img id="navProfileContent" class="nav-profile-avatar" src="${profile.image}" alt="" />`;
    } else {
      btn.innerHTML = `<span id="navProfileContent" data-icon="user" data-icon-size="18" aria-hidden="true"></span>`;
      VD.hydrateIcons(btn);
    }
    btn.title = profile ? profile.name : "Your profile";
    btn.setAttribute("aria-label", profile ? `${profile.name} — your profile` : "Your profile");
  }

  // Mirror the same photo (or fall back to the icon) on the mobile menu's
  // Profile row, so both entry points look consistent.
  const mobileIcon = document.querySelector('.mobile-menu-link[data-route="profile"] .mobile-menu-link-icon');
  if (mobileIcon) {
    if (profile && profile.image) {
      mobileIcon.innerHTML = `<img src="${profile.image}" alt="" />`;
    } else {
      mobileIcon.innerHTML = "";
      mobileIcon.setAttribute("data-icon", "user");
      mobileIcon.setAttribute("data-icon-size", "21");
      VD.hydrateIcons(mobileIcon.parentElement);
    }
  }
}
const navProfileBtn = document.getElementById("navProfile");
if (navProfileBtn) {
  navProfileBtn.addEventListener("click", () => navigate("/profile"));
  VidoraProfile.onChange(updateNavProfileButton);
  updateNavProfileButton();
}

// ---------------- phone: tab bar + full-screen search sheet ----------------
// The four places people actually go are always one thumb-tap away in the tab
// bar; Search opens a full-screen sheet with the keyboard already up.
const tabSearch = document.getElementById("tabSearch");
const mobileMenu = document.getElementById("mobileMenu");
const mobileMenuClose = document.getElementById("mobileMenuClose");
const mobileSearchInput = document.getElementById("mobileSearchInput");

function openMobileMenu() {
  mobileMenu.classList.add("open");
  tabSearch.setAttribute("aria-expanded", "true");
  document.body.classList.add("no-scroll");
  mobileSearchInput.focus();
}
function closeMobileMenu() {
  const wasOpen = mobileMenu.classList.contains("open");
  mobileMenu.classList.remove("open");
  tabSearch.setAttribute("aria-expanded", "false");
  document.body.classList.remove("no-scroll");
  return wasOpen;
}
tabSearch.addEventListener("click", () => {
  mobileMenu.classList.contains("open") ? closeMobileMenu() : openMobileMenu();
});
mobileMenuClose.addEventListener("click", () => { closeMobileMenu(); tabSearch.focus(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (closeMobileMenu()) tabSearch.focus();
});

// "/" jumps to search from anywhere (unless you're already typing somewhere).
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (document.querySelector(".vd-modal-backdrop")) return;
  e.preventDefault();
  if (window.matchMedia("(max-width: 719px)").matches) openMobileMenu();
  else document.getElementById("searchInput").focus();
});

const footerYear = document.getElementById("footerYear");
if (footerYear) footerYear.textContent = String(new Date().getFullYear());

// This script runs at the end of <body> with no defer/async, so the DOM is
// already ready here — calling route() once, directly, is correct.
route();
