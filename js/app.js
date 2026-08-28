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

function escAttr(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
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
        title: `${item.title} — Trailer`,
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
  container.innerHTML = rowSection("More Like This", "similar picks", related);
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
          <span class="section-sub">${sub}</span>
        </div>
      </div>
      <div class="row-scroll-wrap">
        <button type="button" class="row-nav-btn row-nav-prev" aria-label="Scroll left">${VD.icon("chevronLeft", { size: 18 })}</button>
        <div class="row-scroll">${items.map(card).join("")}</div>
        <button type="button" class="row-nav-btn row-nav-next" aria-label="Scroll right">${VD.icon("chevronRight", { size: 18 })}</button>
      </div>
    </section>`;
}

function heroSlideMarkup(item, index, isActive) {
  const href = item.mediaType === "tv" ? `/series/${item.id}` : `/movie/${item.id}`;
  const playHref = item.mediaType === "tv" ? href : `/watch/movie/${item.id}`;
  return `
    <div class="hero-slide${isActive ? " active" : ""}" data-index="${index}">
      <div class="hero-slide-bg" style="${item.backdrop ? `background-image:url('${item.backdrop}')` : ""}"></div>
      <div class="hero-slide-scrim"></div>
      <div class="hero-content">
        <div class="hero-eyebrow">Featured ${item.mediaType === "tv" ? "series" : "film"}</div>
        <h1 class="hero-title">${item.title}</h1>
        <div class="hero-meta">
          ${starRow(item.rating)}
          <span>${item.year || ""}</span>
          ${item.runtime ? `<span>${item.runtime} min</span>` : ""}
        </div>
        <p class="hero-overview">${(item.overview || "").slice(0, 220)}${(item.overview || "").length > 220 ? "…" : ""}</p>
        <div class="hero-actions">
          <a class="btn btn-ticket" href="${playHref}">${VD.icon("playFilled", { size: 15 })} ${item.mediaType === "tv" ? "View episodes" : "Play now"}</a>
          <a class="btn btn-ghost" href="${href}">More info</a>
        </div>
      </div>
    </div>`;
}

function heroBlock(items) {
  if (!items || !items.length) return "";
  const slides = items.map((item, i) => heroSlideMarkup(item, i, i === 0)).join("");
  const dots = items.length > 1
    ? `<div class="hero-dots" role="tablist" aria-label="Featured titles">
        ${items.map((item, i) => `<button type="button" class="hero-dot${i === 0 ? " active" : ""}" data-index="${i}" role="tab" aria-selected="${i === 0}" aria-label="Show ${item.title}"></button>`).join("")}
      </div>`
    : "";
  return `
    <section class="hero" id="heroSection">${slides}${dots}</section>
    <div class="perf perf-top"></div>`;
}

let heroInterval = null;
function stopHeroRotation() {
  if (heroInterval) { clearInterval(heroInterval); heroInterval = null; }
}
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function wireHeroRotation(items) {
  stopHeroRotation();
  const hero = document.getElementById("heroSection");
  if (!hero || !items || items.length < 2) return;

  const slides = [...hero.querySelectorAll(".hero-slide")];
  const dots = [...hero.querySelectorAll(".hero-dot")];
  let index = 0;

  function show(i) {
    index = (i + items.length) % items.length;
    slides.forEach((s, si) => s.classList.toggle("active", si === index));
    dots.forEach((d, di) => {
      d.classList.toggle("active", di === index);
      d.setAttribute("aria-selected", String(di === index));
    });
  }

  function restart() {
    stopHeroRotation();
    if (prefersReducedMotion()) return;
    heroInterval = setInterval(() => show(index + 1), 7000);
  }

  dots.forEach((d) => d.addEventListener("click", () => { show(Number(d.dataset.index)); restart(); }));
  hero.addEventListener("mouseenter", stopHeroRotation);
  hero.addEventListener("mouseleave", restart);

  restart();
}

// Bumped on every route() call so slow/late responses from a page the
// person already navigated away from get dropped instead of clobbering
// whatever's actually on screen.
let routeToken = 0;

function backBar(label, fallbackPath) {
  return `<div class="page-back-row"><button type="button" class="back-btn" data-fallback="${fallbackPath}">${VD.icon("arrowLeft", { size: 15 })} ${label}</button></div>`;
}

function heroBackButton(fallbackPath) {
  return `<button type="button" class="hero-back-btn" data-fallback="${fallbackPath}" aria-label="Go back">${VD.icon("arrowLeft", { size: 19 })}</button>`;
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
  // Validate action payload from extension
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

function loadingState() {
  return `<div class="empty-state"><div class="vd-spinner" aria-hidden="true">${VD.icon("sparkle", { size: 30 })}</div><h3>Loading…</h3></div>`;
}

function emptyState(title, sub, buttonLabel) {
  return `<div class="empty-state"><div class="empty-state-icon" aria-hidden="true">${VD.icon("search", { size: 28 })}</div><h3>${title}</h3><p>${sub}</p>${buttonLabel ? `<button class="btn btn-primary empty-state-btn" type="button" onclick="window.vidoraNavigate('/')">${buttonLabel}</button>` : ""}</div>`;
}

// ---------------- pages ----------------

async function renderHome(token) {
  app.innerHTML = loadingState();
  const [trendingMovies, popularMovies, trendingShows, topRated] = await Promise.all([
    VidoraData.trendingMovies(), VidoraData.popularMovies(),
    VidoraData.trendingShows(), VidoraData.topRatedMovies(),
  ]);
  if (token !== routeToken) return;
  const featured = [...trendingMovies.slice(0, 3), ...trendingShows.slice(0, 2)];
  if (!featured.length) featured.push(...popularMovies.slice(0, 3));
  const cw = VidoraPlayer.getContinueWatching();
  const cwItems = cw.map((c) => ({
    id: c.id, title: c.title, mediaType: c.mediaType, poster: c.poster,
    year: "", rating: null, season: c.season, episode: c.episode,
    resumeHref: c.mediaType === "tv"
      ? `/watch/series/${c.id}/${c.season}/${c.episode}`
      : `/watch/movie/${c.id}`,
  }));

  app.innerHTML = `
    ${heroBlock(featured)}
    ${rowSection("Continue Watching", "pick up where you left off", cwItems)}
    ${rowSection("My List", "saved for later", getMyList())}
    ${rowSection("Trending Now", "movies", trendingMovies)}
    ${rowSection("Trending Series", "shows", trendingShows)}
    ${rowSection("Popular Movies", "on Vidora", popularMovies)}
    ${rowSection("Top Rated", "critics' picks", topRated)}
  `;
  wireHeroRotation(featured);
  wireRowScrollers(app);
}

async function renderGrid(kind, token) {
  app.innerHTML = `
    <div class="wrap">
      <div class="grid-page-head">
        ${backBar("Back", "/")}
        <h1 class="grid-page-title">${kind === "movies" ? "Movies" : "Series"}</h1>
        <p class="grid-page-desc">${kind === "movies" ? "Everything from new releases to all-time favorites." : "Full seasons, ready whenever you are."}</p>
        <div class="chip-row" id="genreChips"></div>
      </div>
      <div class="poster-grid" id="gridItems">${loadingState()}</div>
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
    `<button class="chip ${i === 0 ? "active" : ""}" data-genre="${g}">${g}</button>`).join("");

  function paint(genre) {
    const filtered = genre === "All" ? items : items.filter((i) => (i.genres || []).includes(genre));
    document.getElementById("gridItems").innerHTML = filtered.length
      ? filtered.map(card).join("")
      : emptyState("Nothing here yet", "Try a different genre.");
  }
  paint("All");
  chips.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    chips.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
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
        <p class="grid-page-desc">Titles you've saved to watch later — tap the heart on any poster to add or remove one.</p>
      </div>
      ${items.length
        ? `<div class="poster-grid">${items.map(card).join("")}</div>`
        : emptyState("Your list is empty", "Tap the heart on any movie or series to save it here.")}
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
        body: 'Vidora provides a lightweight front-end for discovering movies and series. The site does not host or distribute media. Playback is provided by external embed providers such as Vidking and URPlayer.',
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
    app.innerHTML = emptyState("Not found", "That title isn't available."); 
    return; 
  }

  // Set the browser tab title dynamically from TMDB data
  document.title = `${m.title} (${m.year || ""}) - Vidora`;

  app.innerHTML = `
    <section class="detail-hero" style="background-image:url('${m.backdrop}')">
      ${heroBackButton("/movies")}
    </section>
    <div class="wrap detail-body">
      <div class="detail-poster">${thumbImg(m.poster, m.title, { w: 500, h: 750 })}</div>
      <div class="detail-main">
        <h1 class="detail-title">${m.title}</h1>
        <div class="detail-meta">
          ${starRow(m.rating)}
          <span>${m.year || ""}</span>
          ${m.runtime ? `<span>${m.runtime} min</span>` : ""}
          ${m.certification ? `<span class="cert-badge">${escAttr(m.certification)}</span>` : ""}
        </div>
        <div class="genre-tags">${(m.genres || []).map((g) => `<span class="genre-tag">${g}</span>`).join("")}</div>
        ${m.certificationDescription ? `<div class="detail-rating-desc">${escAttr(m.certificationDescription)}</div>` : ""}
        ${m.guideUrl ? `<a class="detail-guide-link" href="${escAttr(m.guideUrl)}" target="_blank" rel="noopener">IMDb parental guide</a>` : ""}
        <p class="detail-overview">${m.overview || ""}</p>
        <div class="detail-actions">
          <a class="btn btn-ticket" href="/watch/movie/${m.id}">${VD.icon("playFilled", { size: 15 })} Play movie</a>
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
  if (!s) { app.innerHTML = emptyState("Not found", "That title isn't available."); return; }
  const seasonNum = Number(seasonParam) || s.seasons[0]?.season_number || 1;
  const season = await VidoraData.seasonDetails(id, seasonNum);
  if (token !== routeToken) return;
  if (!season) { app.innerHTML = emptyState("Not found", "That season isn't available."); return; }

  app.innerHTML = `
    <section class="detail-hero" style="background-image:url('${s.backdrop}')">
      ${heroBackButton("/series")}
    </section>
    <div class="wrap detail-body">
      <div class="detail-poster">${thumbImg(s.poster, s.title, { w: 500, h: 750 })}</div>
      <div class="detail-main">
        <h1 class="detail-title">${s.title}</h1>
        <div class="detail-meta">${starRow(s.rating)}<span>${s.year || ""}</span><span>${s.seasons.length} season${s.seasons.length > 1 ? "s" : ""}</span>${s.certification ? `<span class="cert-badge">${escAttr(s.certification)}</span>` : ""}</div>
        <div class="genre-tags">${(s.genres || []).map((g) => `<span class="genre-tag">${g}</span>`).join("")}</div>
        ${s.certificationDescription ? `<div class="detail-rating-desc">${escAttr(s.certificationDescription)}</div>` : ""}
        ${s.guideUrl ? `<a class="detail-guide-link" href="${escAttr(s.guideUrl)}" target="_blank" rel="noopener">IMDb parental guide</a>` : ""}
        <p class="detail-overview">${s.overview || ""}</p>
        <div class="detail-actions">
          <a class="btn btn-ticket" href="/watch/series/${id}/${seasonNum}/${season.episodes[0]?.episode_number || 1}">${VD.icon("playFilled", { size: 15 })} Play Season ${seasonNum}</a>
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
            <div class="episode-row">
              <div class="episode-num">${String(e.episode_number).padStart(2, "0")}</div>
              <div class="episode-thumb">${thumbImg(e.still, `${s.title} — ${e.name}`, { w: 300, h: 169 })}</div>
              <div>
                <div class="episode-name">${e.name}</div>
                <div class="episode-overview">${e.overview || ""}</div>
              </div>
              <div style="display:flex;align-items:center;gap:14px;">
                <span class="episode-runtime">${e.runtime ? e.runtime + " min" : ""}</span>
                <a class="episode-play" href="/watch/series/${id}/${seasonNum}/${e.episode_number}" title="Play episode ${e.episode_number}">${VD.icon("playFilled", { size: 14 })}</a>
              </div>
            </div>`).join("")}
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

const RESUME_MIN_SECONDS = 15;
function offerResume(progress, buildResumedSrc) {
  if (!progress || !progress.currentTime || progress.currentTime < RESUME_MIN_SECONDS) return;
  if (progress.duration && progress.progress >= 0.95) return;

  const mins = Math.floor(progress.currentTime / 60);
  const secs = Math.floor(progress.currentTime % 60).toString().padStart(2, "0");
  const timeLabel = `${mins}:${secs}`;

  VD.modal({
    title: "Resume where you left off?",
    sub: `You were at ${timeLabel}.`,
    actions: [
      { id: "restart", label: "Start over", variant: "btn-ghost", onClick: (close) => close() },
      { id: "resume", label: `Resume at ${timeLabel}`, variant: "btn-primary", onClick: (close) => {
          const iframe = document.querySelector(".player-frame-wrap iframe");
          if (iframe) iframe.src = buildResumedSrc(progress.currentTime);
          close();
        } },
    ],
  });
}

function playerDetailsBlock(item, features) {
  return `
    <div class="player-details">
      <div class="player-details-main">
        <div class="detail-meta">
          ${starRow(item.rating)}
          ${item.year ? `<span>${item.year}</span>` : ""}
          ${item.certification ? `<span class="cert-badge">${escAttr(item.certification)}</span>` : ""}
          ${item.runtime ? `<span>${item.runtime} min</span>` : ""}
        </div>
        ${(item.genres || []).length ? `<div class="genre-tags">${item.genres.map((g) => `<span class="genre-tag">${g}</span>`).join("")}</div>` : ""}
        ${item.overview ? `<p class="player-overview">${item.overview}</p>` : ""}
      </div>
      <ul class="player-features">
        ${features.map((f) => `<li><span class="pf-icon" aria-hidden="true">${f.icon}</span>${f.label}</li>`).join("")}
      </ul>
    </div>`;
}

async function renderWatchMovie(id, token) {
  app.innerHTML = loadingState();
  const m = await VidoraData.movieDetails(id);
  if (token !== routeToken) return;
  if (!m) { app.innerHTML = emptyState("Not found", "That title isn't available."); return; }
  document.title = `${m.title} - Vidora`;
  const partyState = VidoraParty.isGuest() && VidoraParty.getMediaMeta() &&
    String(VidoraParty.getMediaMeta().id) === String(id) && VidoraParty.getMediaMeta().mediaType === "movie"
    ? VidoraParty.getLastState() : null;
  const progress = VidoraPlayer.getProgress(id, "movie");
  const src = partyState
    ? VidoraPlayer.movieUrl(id, partyState.currentTime || 0, partyState.event !== "pause")
    : VidoraPlayer.movieUrl(id, 0);

  app.innerHTML = `
    <div class="wrap player-page">
      <div class="player-topbar">
        <a class="player-back" href="/movie/${id}">${VD.icon("arrowLeft", { size: 15 })} Back</a>
        <span class="player-title">${m.title}</span>
      </div>
      <div class="player-frame-wrap">
        <div id="player-host-placeholder"></div>
      </div>
      ${playerDetailsBlock(m, [
        { icon: VD.icon("save", { size: 15 }), label: "Progress is saved automatically as you watch" },
        { icon: VD.icon("users", { size: 15 }), label: "Start a Watch Party to watch in sync with friends" },
        { icon: VD.icon("maximize", { size: 15 }), label: "Full screen playback on any device" },
      ])}
      <div id="partyContainer"></div>
    </div>`;

  VidoraPlayer.init({ id, title: m.title, mediaType: "movie", poster: m.poster }, VidoraParty.createHostSync());

  // player shim that PartyUI will talk to via `.src` assignments
  const playerShim = {
    _src: null,
    set src(val) { this._src = val; handleEmbedSrc(val); },
    get src() { return this._src; }
  };

  PartyUI.mount(document.getElementById("partyContainer"), {
    mediaType: "movie", id, title: m.title, poster: m.poster,
    getIframe: () => playerShim,
    buildSrc: (t, autoplay) => VidoraPlayer.movieUrl(id, t, autoplay),
  });

  // initial load via rip+proxy → inject custom player
  async function handleEmbedSrc(embedUrl) {
    if (!embedUrl) return;
    try {
      const r = await fetch(`/api/rip?embed=${encodeURIComponent(embedUrl)}`);
      const j = await r.json();
      const proxied = j.proxiedUrl || (j.streamUrl ? `/api/proxy?token=${encodeURIComponent(j.streamUrl)}` : null);
      if (!proxied) {
        console.warn('No proxied URL from rip');
        return;
      }
      // opts: try to extract progress/autoplay from embedUrl query
      let startTime = 0; let autoplay = false;
      try { const u = new URL(embedUrl); startTime = Number(u.searchParams.get('progress')) || 0; autoplay = (u.searchParams.get('autoPlay') === 'true' || u.searchParams.get('autoplay') === '1'); } catch {}
      if (window.injectCustomPlayer) window.injectCustomPlayer({ src: proxied, poster: m.poster }, { startTime, autoplay });
    } catch (err) { console.error('embed rip failed', err); }
  }

  // kick off initial load
  handleEmbedSrc(src);

  if (!partyState) offerResume(progress, (t) => VidoraPlayer.movieUrl(id, t, true));
}

async function renderWatchSeries(id, season, episode, token) {
  app.innerHTML = loadingState();
  const [s, se] = await Promise.all([VidoraData.showDetails(id), VidoraData.seasonDetails(id, season)]);
  if (token !== routeToken) return;
  if (!s) { app.innerHTML = emptyState("Not found", "That title isn't available."); return; }
  document.title = `S${season}E${episode} - ${s.title} - Vidora`;
  const ep = se.episodes.find((e) => e.episode_number === Number(episode));
  const partyState = VidoraParty.isGuest() && VidoraParty.getMediaMeta() &&
    String(VidoraParty.getMediaMeta().id) === String(id) && VidoraParty.getMediaMeta().mediaType === "tv" &&
    String(VidoraParty.getMediaMeta().season) === String(season) && String(VidoraParty.getMediaMeta().episode) === String(episode)
    ? VidoraParty.getLastState() : null;
  const progress = VidoraPlayer.getProgress(id, "tv", season, episode);
  const src = partyState
    ? VidoraPlayer.tvUrl(id, season, episode, partyState.currentTime || 0, partyState.event !== "pause")
    : VidoraPlayer.tvUrl(id, season, episode, 0);

  app.innerHTML = `
    <div class="wrap player-page">
      <div class="player-topbar">
        <a class="player-back" href="/series/${id}/${season}">${VD.icon("arrowLeft", { size: 15 })} Back to episodes</a>
        <span class="player-title">${s.title} · S${season}E${episode}${ep ? " — " + ep.name : ""}</span>
      </div>
      <div class="player-frame-wrap">
        <div id="player-host-placeholder"></div>
      </div>
      ${playerDetailsBlock(
        { rating: s.rating, year: s.year, genres: s.genres, runtime: ep && ep.runtime, overview: (ep && ep.overview) || s.overview },
        [
          { icon: VD.icon("save", { size: 15 }), label: "Progress is saved automatically per episode" },
          { icon: VD.icon("skipForward", { size: 15 }), label: "Auto-plays the next episode when this one ends" },
          { icon: VD.icon("users", { size: 15 }), label: "Start a Watch Party to watch in sync with friends" },
        ],
      )}
      <div id="partyContainer"></div>
    </div>`;

  VidoraPlayer.init({ id, title: s.title, mediaType: "tv", poster: s.poster, season, episode }, VidoraParty.createHostSync());

  const playerShim = {
    _src: null,
    set src(val) { this._src = val; handleEmbedSrc(val); },
    get src() { return this._src; }
  };

  PartyUI.mount(document.getElementById("partyContainer"), {
    mediaType: "tv", id, season, episode, title: s.title, poster: s.poster,
    getIframe: () => playerShim,
    buildSrc: (t, autoplay) => VidoraPlayer.tvUrl(id, season, episode, t, autoplay),
  });

  async function handleEmbedSrc(embedUrl) {
    if (!embedUrl) return;
    try {
      const r = await fetch(`/api/rip?embed=${encodeURIComponent(embedUrl)}`);
      const j = await r.json();
      const proxied = j.proxiedUrl || (j.streamUrl ? `/api/proxy?token=${encodeURIComponent(j.streamUrl)}` : null);
      if (!proxied) return;
      let startTime = 0; let autoplay = false;
      try { const u = new URL(embedUrl); startTime = Number(u.searchParams.get('progress')) || 0; autoplay = (u.searchParams.get('autoPlay') === 'true' || u.searchParams.get('autoplay') === '1'); } catch {}
      if (window.injectCustomPlayer) window.injectCustomPlayer({ src: proxied, poster: s.poster }, { startTime, autoplay });
    } catch (err) { console.error('embed rip failed', err); }
  }

  handleEmbedSrc(src);

  if (!partyState) offerResume(progress, (t) => VidoraPlayer.tvUrl(id, season, episode, t, true));
}

async function renderSearch(query, token) {
  app.innerHTML = `
    <div class="wrap">
      <div class="grid-page-head">
        <h1 class="grid-page-title">Results for “${query}”</h1>
      </div>
      <div id="searchResults">${loadingState()}</div>
    </div>`;
  const { movies, shows } = await VidoraData.search(query);
  if (token !== routeToken) return;
  const el = document.getElementById("searchResults");
  if (!movies.length && !shows.length) {
    el.innerHTML = emptyState("No matches", "Try a different title or keyword.");
    return;
  }
  el.innerHTML = `
    ${movies.length ? `<h2 class="section-title" style="margin:20px 0 14px;">Movies</h2><div class="poster-grid">${movies.map(card).join("")}</div>` : ""}
    ${shows.length ? `<h2 class="section-title" style="margin:20px 0 14px;">Series</h2><div class="poster-grid">${shows.map(card).join("")}</div>` : ""}
  `;
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
  document.querySelectorAll(".nav-links a, .mobile-menu-links a").forEach((a) => {
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
  const myToken = ++routeToken;
  const matched = matchRoute(location.pathname);
  if (!matched || !matched.route.modal) window.scrollTo(0, 0);
  closeMobileMenu();
  stopHeroRotation();
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

function wireSearchInput(input) {
  if (!input) return;

  // Create suggestions container
  const wrap = input.parentElement;
  let sugEl = wrap.querySelector('.search-suggestions');
  if (!sugEl) {
    sugEl = document.createElement('div');
    sugEl.className = 'search-suggestions';
    sugEl.style.display = 'none';
    wrap.appendChild(sugEl);
  }

  let suggestions = [];
  let activeIndex = -1;
  let lastQuery = '';

  function renderSuggestions(list) {
    suggestions = list || [];
    activeIndex = -1;
    if (!suggestions.length) {
      sugEl.style.display = 'none';
      sugEl.innerHTML = '';
      return;
    }
    sugEl.innerHTML = suggestions.map((s, i) =>
      `<div class="suggestion-item" role="option" data-index="${i}" data-href="${escAttr(s.href)}">
         <img class="suggestion-thumb" src="${escAttr(s.image)}" alt="${escAttr(s.title)} poster" />
         <div class="suggestion-copy">
           <span class="suggestion-title">${escAttr(s.title)}</span>
           <span class="suggestion-meta">${escAttr(s.year || '')} · ${escAttr(s.type)}</span>
         </div>
       </div>`).join('');
    sugEl.style.display = '';
  }

  function setActive(i) {
    const items = sugEl.querySelectorAll('.suggestion-item');
    items.forEach((it) => it.classList.remove('active'));
    if (i >= 0 && items[i]) {
      items[i].classList.add('active');
      items[i].scrollIntoView({ block: 'nearest' });
      activeIndex = i;
    } else {
      activeIndex = -1;
    }
  }

  function clearSuggestions() { renderSuggestions([]); }

  // Debounced search
  let debounceTimer = null;
  function scheduleQuery(q) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      const val = (q || '').trim();
      if (!val) { clearSuggestions(); return; }
      lastQuery = val;
      try {
        const res = await VidoraData.search(val);
        // Merge movies and shows, prioritise movies then shows, limit 8
        const items = [ ...(res.movies || []), ...(res.shows || []) ].slice(0, 8).map((it) => ({
          title: it.title || it.name || '',
          year: it.year || it.first_air_date || it.year || '',
          href: it.mediaType === 'tv' ? `/series/${it.id}` : `/movie/${it.id}`,
          type: it.mediaType === 'tv' ? 'Series' : 'Movie',
          image: it.poster || it.backdrop || VidoraData.placeholder(it.title || it.name || 'Title', 80, 120),
        }));
        // Only render if query hasn't changed
        if (lastQuery === val) renderSuggestions(items);
      } catch (err) {
        console.error('Search suggestions failed', err);
        clearSuggestions();
      }
    }, 240);
  }

  input.addEventListener('input', (e) => {
    scheduleQuery(input.value);
  });

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, suggestions.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      if (activeIndex >= 0 && suggestions[activeIndex]) {
        e.preventDefault();
        closeMobileMenu();
        navigate(suggestions[activeIndex].href);
        clearSuggestions();
      } else if (input.value.trim()) {
        closeMobileMenu();
        navigate(`/search/${encodeURIComponent(input.value.trim())}`);
        clearSuggestions();
      }
      return;
    }
    if (e.key === 'Escape') {
      clearSuggestions();
      return;
    }
  });

  // Click on suggestion
  sugEl.addEventListener('click', (ev) => {
    const item = ev.target.closest('.suggestion-item');
    if (!item) return;
    const href = item.dataset.href;
    if (href) {
      closeMobileMenu();
      navigate(href);
      clearSuggestions();
    }
  });

  // Mouseover to set active
  sugEl.addEventListener('mousemove', (ev) => {
    const item = ev.target.closest('.suggestion-item');
    if (!item) return;
    const i = Number(item.dataset.index);
    if (!Number.isNaN(i)) setActive(i);
  });

  // Click outside to close
  document.addEventListener('click', (ev) => {
    if (!wrap.contains(ev.target)) clearSuggestions();
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

// ---------------- fullscreen mobile menu ----------------
const navToggle = document.getElementById("navToggle");
const mobileMenu = document.getElementById("mobileMenu");
const mobileMenuClose = document.getElementById("mobileMenuClose");

function openMobileMenu() {
  mobileMenu.classList.add("open");
  requestAnimationFrame(() => mobileMenu.classList.add("animate-in"));
  navToggle.classList.add("is-open");
  navToggle.setAttribute("aria-expanded", "true");
  navToggle.setAttribute("aria-label", "Close menu");
  document.body.classList.add("no-scroll");
  mobileMenuClose.focus();
}
function closeMobileMenu() {
  const wasOpen = mobileMenu.classList.contains("open");
  mobileMenu.classList.remove("open", "animate-in");
  navToggle.classList.remove("is-open");
  navToggle.setAttribute("aria-expanded", "false");
  navToggle.setAttribute("aria-label", "Open menu");
  document.body.classList.remove("no-scroll");
  return wasOpen;
}
navToggle.addEventListener("click", () => {
  mobileMenu.classList.contains("open") ? closeMobileMenu() : openMobileMenu();
});
mobileMenuClose.addEventListener("click", () => { closeMobileMenu(); navToggle.focus(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (closeMobileMenu()) navToggle.focus();
});

// This script runs at the end of <body> with no defer/async, so the DOM is
// already ready here — calling route() once, directly, is correct.
route();
