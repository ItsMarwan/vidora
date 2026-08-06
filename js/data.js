/**
 * VIDORA — DATA LAYER
 * Exposes one interface (VidoraData) that talks to YOUR OWN /api/tmdb
 * proxy (which holds the real TMDB key server-side). If the server has no
 * key configured, or a call fails for any reason, every method falls back
 * to the bundled demo catalog automatically — there's no separate
 * "demo mode" flag to manage on the client anymore, it's just what happens
 * when the live call doesn't work.
 *
 * LANGUAGE-AWARE CATALOG (see js/i18n.js / VidoraLang):
 * Every listing method (home rows, movie/series grids, search) now checks
 * VidoraLang.isArabic() and serves a DIFFERENT catalog, not just a
 * different player:
 *   - English mode: TMDB's normal trending/popular/top-rated endpoints,
 *     with Arabic-original titles filtered OUT.
 *   - Arabic mode: TMDB's /discover endpoints constrained to
 *     with_original_language=ar (sorted by popularity or rating to stand
 *     in for "trending"/"top rated"), so only Arabic-language film & TV
 *     shows up.
 * Detail-page lookups (movieDetails/showDetails/seasonDetails) are NOT
 * filtered — once a title's id is known (because it already came from a
 * correctly-filtered list, or a Watch Party / Continue Watching entry),
 * fetching its details doesn't need a language check.
 */

const VidoraData = (() => {
  function isArabicMode() {
    return typeof VidoraLang !== "undefined" && VidoraLang.isArabic();
  }

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

  // ---------- demo dataset: English ----------
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

  // ---------- demo dataset: Arabic (original-language "ar") ----------
  // Separate id ranges (300xxx movies / 400xxx shows) so they never
  // collide with the English demo ids above — both sets can be searched
  // by id at once on detail pages without ambiguity.
  const demoMoviesAr = [
    { id: 300101, title: "ليالي الإسكندرية", year: 2024, rating: 8.3, runtime: 121, genres: ["Drama", "Thriller"],
      overview: "عامل مسرح في سينما قديمة على وشك الإغلاق يكتشف أن آخر بكرة فيلم في غرفة العرض تخفي سرًا عمره عشر سنوات ظل صاحب السينما يحاول دفنه.", accent: "b23a48" },
    { id: 300102, title: "أفق الصحراء", year: 2023, rating: 7.8, runtime: 128, genres: ["Sci-Fi", "Action"],
      overview: "حين تنقطع الأقمار الصناعية عن الأرض في ليلة واحدة، يُستدعى مهندس اتصالات متقاعد لتعقب إشارة غامضة لا يجب أن تكون موجودة أصلاً.", accent: "3a6ea5" },
    { id: 300103, title: "دور المرآة", year: 2022, rating: 7.1, runtime: 102, genres: ["Drama"],
      overview: "بعد اختياره بديلاً للبطل قبل ثلاثة أيام من العرض الافتتاحي، يبدأ ممثل متردد بفقدان الحدود بين شخصيته وشخصيته الحقيقية.", accent: "6b4c93" },
    { id: 300104, title: "انحسار الموج", year: 2024, rating: 8.0, runtime: 119, genres: ["Mystery", "Thriller"],
      overview: "الانحسار السنوي لمياه بلدة ساحلية يكشف هذا العام أكثر من مجرد حطام — والمحقق الذي غادر منذ عشر سنوات هو الوحيد الذي يتذكر السبب.", accent: "1f7a6c" },
    { id: 300105, title: "نشرة الصباح", year: 2021, rating: 7.5, runtime: 95, genres: ["Comedy", "Drama"],
      overview: "مؤسس تطبيق للتنبؤ بالطقس يبدأ بالتنبؤ بانهيار حياته الخاصة بدقة مقلقة.", accent: "c98a2c" },
    { id: 300106, title: "الأبواب التسعة", year: 2023, rating: 8.5, runtime: 138, genres: ["Mystery", "Thriller"],
      overview: "تسعة أشقاء متباعدين يُستدعون إلى عزبة والدهم الراحل، حيث لا يمكن فتح الوصية إلا بعد فتح كل باب مغلق — بالترتيب.", accent: "8a2c3b" },
    { id: 300107, title: "التيار العائد", year: 2020, rating: 7.3, runtime: 107, genres: ["Sci-Fi", "Drama"],
      overview: "عالمة أحياء بحرية تدرس تيارًا مكتشفًا حديثًا تجد أنه يعيد كتابة أنماط الهجرة لكل ما يلمسه، بما في ذلك هي نفسها.", accent: "2c6a8a" },
    { id: 300108, title: "الاستراحة الطويلة", year: 2019, rating: 6.9, runtime: 110, genres: ["Drama", "Comedy"],
      overview: "بعد عشرين عامًا من توقف عرض مسرحي جائل فجأة، يجتمع الطاقم الأصلي أخيرًا لإنهاء الفصل الأخير.", accent: "9c6b2c" },
  ];

  const demoShowsAr = [
    { id: 400201, title: "محطة الإرسال", year: 2023, rating: 8.6, genres: ["Sci-Fi", "Mystery"], accent: "3a6ea5",
      overview: "في مدينة لا تزال بيوتها تعمل بالتلفزيون التناظري، يبدأ فني صيانة باكتشاف بثوث من محطات أُغلقت منذ عقود.",
      seasons: [
        { season_number: 1, name: "الموسم الأول", episodes: eps(1, 8, "محطة الإرسال", "3a6ea5", "ar") },
        { season_number: 2, name: "الموسم الثاني", episodes: eps(2, 6, "محطة الإرسال", "3a6ea5", "ar") },
      ]},
    { id: 400202, title: "المناوبة الليلية", year: 2024, rating: 7.9, genres: ["Comedy"], accent: "c98a2c",
      overview: "طاقم الليل في مبنى أرشيف يعمل ٢٤ ساعة هو من يبقي العملية بأكملها متماسكة بينما يحصد من فوقهم كل الفضل.",
      seasons: [
        { season_number: 1, name: "الموسم الأول", episodes: eps(1, 10, "المناوبة الليلية", "c98a2c", "ar") },
      ]},
    { id: 400203, title: "دفتر الملاح", year: 2022, rating: 8.8, genres: ["Drama", "Mystery"], accent: "6b4c93",
      overview: "مُشغّل معدية في بلدة نهرية يحتفظ بدفتر خاص لكل من عبر ولم يعد — والقائمة تطول باستمرار.",
      seasons: [
        { season_number: 1, name: "الموسم الأول", episodes: eps(1, 8, "دفتر الملاح", "6b4c93", "ar") },
        { season_number: 2, name: "الموسم الثاني", episodes: eps(2, 8, "دفتر الملاح", "6b4c93", "ar") },
        { season_number: 3, name: "الموسم الثالث", episodes: eps(3, 5, "دفتر الملاح", "6b4c93", "ar") },
      ]},
    { id: 400204, title: "ملاحظات ميدانية", year: 2021, rating: 7.4, genres: ["Drama", "Action"], accent: "1f7a6c",
      overview: "وحدة إطفاء حرائق تم حلها يُعاد استدعاؤها لموسم أخير لم يوافق عليه أحد منهم.",
      seasons: [
        { season_number: 1, name: "الموسم الأول", episodes: eps(1, 6, "ملاحظات ميدانية", "1f7a6c", "ar") },
      ]},
    { id: 400205, title: "إذاعة منتصف الليل", year: 2024, rating: 7.7, genres: ["Drama", "Mystery"], accent: "b23a48",
      overview: "مذيع برنامج مكالمات ليلي يبدأ باستقبال مكالمات من رقم توقف عن الخدمة منذ عام.",
      seasons: [
        { season_number: 1, name: "الموسم الأول", episodes: eps(1, 8, "إذاعة منتصف الليل", "b23a48", "ar") },
      ]},
    { id: 400206, title: "المُدرّس البديل", year: 2023, rating: 7.2, genres: ["Comedy", "Drama"], accent: "8a2c3b",
      overview: "مُدرّس بديل يستمر في التكليف بنفس الفصل، في نفس الغرفة، لمدرسة أُغلقت الربيع الماضي.",
      seasons: [
        { season_number: 1, name: "الموسم الأول", episodes: eps(1, 8, "المُدرّس البديل", "8a2c3b", "ar") },
      ]},
    { id: 400207, title: "ضوء المرفأ", year: 2022, rating: 8.2, genres: ["Drama", "Action"], accent: "2c6a8a",
      overview: "حارسة منارة تم إيقافها عن العمل ترفض مغادرة موقعها حتى بعد أن يخبرها خفر السواحل أن الوظيفة لم تعد موجودة.",
      seasons: [
        { season_number: 1, name: "الموسم الأول", episodes: eps(1, 7, "ضوء المرفأ", "2c6a8a", "ar") },
        { season_number: 2, name: "الموسم الثاني", episodes: eps(2, 7, "ضوء المرفأ", "2c6a8a", "ar") },
      ]},
    { id: 400208, title: "الوقت الإضافي", year: 2021, rating: 7.5, genres: ["Comedy", "Sci-Fi"], accent: "9c6b2c",
      overview: "حكم في دوري صغير يبدأ بملاحظة أن الساعة لا تصل أبدًا إلى الصفر في مبارياته — ولم يلاحظ أحد آخر ذلك إطلاقًا.",
      seasons: [
        { season_number: 1, name: "الموسم الأول", episodes: eps(1, 6, "الوقت الإضافي", "9c6b2c", "ar") },
      ]},
  ];

  // `lang` picks which pool of filler episode titles/overview phrasing to
  // use — defined at module scope (not inside the arrays above) since both
  // the English and Arabic show lists call it while being built.
  function eps(season, count, showTitle, accent = "3a6ea5", lang = "en") {
    const titlesEn = ["Static", "The Handoff", "Low Ground", "Every Other Tuesday", "What the Ledger Says",
      "Backfill", "No Signal", "Company Line", "Half Measures", "Sign-Off"];
    const titlesAr = ["البداية", "التسليم", "أرضية منخفضة", "كل ثلاثاء آخر", "ما يقوله الدفتر",
      "تعويض", "لا إشارة", "سياسة الشركة", "إجراءات نصف كاملة", "نهاية البث"];
    const titles = lang === "ar" ? titlesAr : titlesEn;
    return Array.from({ length: count }, (_, i) => ({
      episode_number: i + 1,
      name: titles[i % titles.length],
      overview: lang === "ar"
        ? `${showTitle} — الموسم ${season} الحلقة ${i + 1}: يتعامل الطاقم مع تداعيات قرار الحلقة الماضية، والأمور لا تسير كما خطط لها أحد.`
        : `${showTitle} S${season}E${i + 1} — the crew deals with the fallout from last episode's decision, and it doesn't go the way anyone planned.`,
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
  const demoMoviesArDecorated = demoMoviesAr.map((m) => decorate(m, false));
  const demoShowsArDecorated = demoShowsAr.map((s) => decorate(s, true));

  // ---------- server proxy fetch helper ----------
  // Calls YOUR OWN /api/tmdb endpoint, passing the same relative path TMDB
  // itself would use as a ?path= query param (e.g. ?path=/movie/12345)
  // instead of appending it to the URL path. The real key is attached
  // server-side; this call carries none of it. Any extra `params` (e.g.
  // with_original_language, sort_by) are forwarded straight through to
  // TMDB by api/tmdb.js.
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
      originalLanguage: m.original_language,
    };
  }

  function adaptShow(s) {
    return {
      id: s.id, title: s.name, year: (s.first_air_date || "").slice(0, 4),
      rating: Math.round((s.vote_average || 0) * 10) / 10, overview: s.overview,
      poster: img(s.poster_path), backdrop: img(s.backdrop_path, "w1280"),
      genres: (s.genres || []).map((g) => g.name), mediaType: "tv",
      seasons: (s.seasons || []).filter((se) => se.season_number > 0),
      originalLanguage: s.original_language,
    };
  }

  // ---------- language-aware discover helpers ----------
  // TMDB's /trending and /popular endpoints don't support filtering by a
  // title's original language, so for Arabic mode we use /discover
  // constrained to with_original_language=ar instead — sorted by
  // popularity (stands in for "trending"/"popular") or by rating (for
  // "top rated"). This is what actually restricts the catalog to Arabic
  // film & TV rather than just translating UI chrome around it.
  async function discoverMovies(extraParams) {
    const d = await tmdb("/discover/movie", { with_original_language: "ar", ...extraParams });
    return (d.results || []).map(adaptMovie);
  }
  async function discoverShows(extraParams) {
    const d = await tmdb("/discover/tv", { with_original_language: "ar", ...extraParams });
    return (d.results || []).map(adaptShow);
  }

  // ---------- public API ----------
  const api = {
    img, placeholder, localFallback,

    async trendingMovies() {
      if (isArabicMode()) {
        return tmdbOrDemoFallback(
          () => discoverMovies({ sort_by: "popularity.desc" }),
          () => demoMoviesArDecorated.slice(0, 8),
        );
      }
      return tmdbOrDemoFallback(
        async () => (await tmdb("/trending/movie/week")).results
          .filter((m) => m.original_language !== "ar").map(adaptMovie),
        () => demoMoviesDecorated.slice(0, 8),
      );
    },
    async popularMovies() {
      if (isArabicMode()) {
        return tmdbOrDemoFallback(
          () => discoverMovies({ sort_by: "popularity.desc", page: 2 }),
          () => [...demoMoviesArDecorated].reverse(),
        );
      }
      return tmdbOrDemoFallback(
        async () => (await tmdb("/movie/popular")).results
          .filter((m) => m.original_language !== "ar").map(adaptMovie),
        () => [...demoMoviesDecorated].reverse(),
      );
    },
    async topRatedMovies() {
      if (isArabicMode()) {
        return tmdbOrDemoFallback(
          () => discoverMovies({ sort_by: "vote_average.desc", "vote_count.gte": 20 }),
          () => [...demoMoviesArDecorated].sort((a, b) => b.rating - a.rating),
        );
      }
      return tmdbOrDemoFallback(
        async () => (await tmdb("/movie/top_rated")).results
          .filter((m) => m.original_language !== "ar").map(adaptMovie),
        () => [...demoMoviesDecorated].sort((a, b) => b.rating - a.rating),
      );
    },
    async trendingShows() {
      if (isArabicMode()) {
        return tmdbOrDemoFallback(
          () => discoverShows({ sort_by: "popularity.desc" }),
          () => demoShowsArDecorated.slice(0, 8),
        );
      }
      return tmdbOrDemoFallback(
        async () => (await tmdb("/trending/tv/week")).results
          .filter((s) => s.original_language !== "ar").map(adaptShow),
        () => demoShowsDecorated.slice(0, 8),
      );
    },
    async popularShows() {
      if (isArabicMode()) {
        return tmdbOrDemoFallback(
          () => discoverShows({ sort_by: "popularity.desc", page: 2 }),
          () => [...demoShowsArDecorated].reverse(),
        );
      }
      return tmdbOrDemoFallback(
        async () => (await tmdb("/tv/popular")).results
          .filter((s) => s.original_language !== "ar").map(adaptShow),
        () => [...demoShowsDecorated].reverse(),
      );
    },
    async topRatedShows() {
      if (isArabicMode()) {
        return tmdbOrDemoFallback(
          () => discoverShows({ sort_by: "vote_average.desc", "vote_count.gte": 20 }),
          () => [...demoShowsArDecorated].sort((a, b) => b.rating - a.rating),
        );
      }
      return tmdbOrDemoFallback(
        async () => (await tmdb("/tv/top_rated")).results
          .filter((s) => s.original_language !== "ar").map(adaptShow),
        () => [...demoShowsDecorated].sort((a, b) => b.rating - a.rating),
      );
    },
    async movieDetails(id) {
      // Not language-filtered on purpose — by the time a specific id is
      // requested it already came from a correctly-filtered list (or the
      // user's own Continue Watching / My List / a Watch Party invite).
      return tmdbOrDemoFallback(
        async () => {
          const m = await tmdb(`/movie/${id}`);
          const base = adaptMovie(m);
          // Try to find a country-specific certification (prefer US)
          try {
            const rd = await tmdb(`/movie/${id}/release_dates`);
            const results = rd.results || [];
            const us = results.find((r) => r.iso_3166_1 === 'US') || results[0];
            let cert = "";
            if (us && Array.isArray(us.release_dates)) {
              const r = us.release_dates.find((d) => d.certification && d.certification.trim());
              cert = r ? r.certification : "";
            }
            base.certification = cert || "";
          } catch (e) { base.certification = ""; }
          return base;
        },
        () => {
          const m = [...demoMoviesDecorated, ...demoMoviesArDecorated].find((m) => String(m.id) === String(id));
          if (!m) return m;
          return { ...m, certification: m.certification || (m.rating && m.rating >= 8 ? '16+' : '13+') };
        },
      );
    },
    async showDetails(id) {
      return tmdbOrDemoFallback(
        async () => {
          const s = await tmdb(`/tv/${id}`);
          const base = adaptShow(s);
          try {
            const cr = await tmdb(`/tv/${id}/content_ratings`);
            const results = cr.results || [];
            const us = results.find((r) => r.iso_3166_1 === 'US') || results[0];
            base.certification = us && us.rating ? us.rating : "";
          } catch (e) { base.certification = ""; }
          return base;
        },
        () => {
          const s = [...demoShowsDecorated, ...demoShowsArDecorated].find((s) => String(s.id) === String(id));
          if (!s) return s;
          return { ...s, certification: s.certification || (s.rating && s.rating >= 8 ? '16+' : '13+') };
        },
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
          const show = [...demoShowsDecorated, ...demoShowsArDecorated].find((s) => String(s.id) === String(showId));
          return show && show.seasons.find((se) => se.season_number === Number(seasonNumber));
        },
      );
    },
    async search(query) {
      if (!query) return { movies: [], shows: [] };
      const arabic = isArabicMode();
      return tmdbOrDemoFallback(
        async () => {
          const d = await tmdb("/search/multi", { query });
          // TMDB's search endpoint has no with_original_language filter,
          // so the language split happens client-side against each
          // result's own original_language field.
          const keep = (r) => (arabic ? r.original_language === "ar" : r.original_language !== "ar");
          return {
            movies: d.results.filter((r) => r.media_type === "movie" && keep(r)).map(adaptMovie),
            shows: d.results.filter((r) => r.media_type === "tv" && keep(r)).map(adaptShow),
          };
        },
        () => {
          const q = query.toLowerCase();
          const moviePool = arabic ? demoMoviesArDecorated : demoMoviesDecorated;
          const showPool = arabic ? demoShowsArDecorated : demoShowsDecorated;
          return {
            movies: moviePool.filter((m) => m.title.toLowerCase().includes(q)),
            shows: showPool.filter((s) => s.title.toLowerCase().includes(q)),
          };
        },
      );
    },
  };

  // Picks a random movie or show from a broad-ish pool ("Surprise Me").
  // Already language-aware for free — it's built from the methods above,
  // which each check VidoraLang internally.
  api.randomTitle = async function randomTitle() {
    const [tm, ts, pm, ps] = await Promise.all([
      api.trendingMovies(), api.trendingShows(), api.popularMovies(), api.popularShows(),
    ]);
    const pool = [...tm, ...ts, ...pm, ...ps];
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  };

  // Finds other titles of the SAME media type sharing at least one genre
  // with `item`, for the "More Like This" row. Also inherits language
  // filtering for free through trendingShows()/popularMovies()/etc.
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
