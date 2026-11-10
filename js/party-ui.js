/**
 * VIDORA — WATCH PARTY UI
 * Wires VidoraParty + VidoraStage + VD components into the watch pages.
 *
 * All VidoraParty listeners here are registered exactly ONCE, at module
 * load — not inside mount(). Watch pages call mount() on every navigation,
 * and re-subscribing there used to stack up a fresh listener per visit, so
 * one state broadcast could trigger several redundant reloads. Listeners
 * read from `currentContainer`/`currentCtx`, two module-level pointers that
 * mount()/unmount() simply update.
 *
 * mount(container, ctx) — ctx:
 *   { mediaType, id, season?, episode?, title, poster, stage }
 *   `stage` is the VidoraStage of the watch page. The party never touches
 *   an iframe or <video> itself; it asks the stage to bring the player to
 *   the host's position, and the stage does that the right way for
 *   whichever kind of player is on screen.
 *
 * HOW A GUEST FOLLOWS THE HOST
 *   - Each host command (play / pause / seek) and every guest tick works
 *     from VidoraParty.getHostPosition(): the host's position projected to
 *     "right now". Nothing here compares against stale snapshots.
 *   - Native player: told directly (instant, no reload). Drift is corrected
 *     in place when a playing guest strays more than NATIVE_DRIFT_SEC.
 *     A guest who paused on purpose is NOT force-resumed by drift checks —
 *     only by the host's next play/pause/seek, or by the "Sync now" button.
 *   - Embed iframe: can only be reloaded, so that's reserved for host
 *     commands and for large drift (IFRAME_DRIFT_SEC).
 * -----------------------------------------------------------
 */

const PartyUI = (() => {
  let currentContainer = null;
  let currentCtx = null;

  const NATIVE_DRIFT_SEC = 2;      // playing guest this far from the host gets nudged (native)
  const IFRAME_DRIFT_SEC = 8;      // ...or reloaded (embed) — a reload is costly, so be lenient
  const BANNER_DRIFT_SEC = 3;      // when to show the "you're out of sync" banner
  const SKIP_RELOAD_WITHIN_SEC = 1.5;
  const AUTOFIX_COOLDOWN_MS = 4000;

  let lastAppliedPlaying = null;   // host play-state at the last state we acted on
  let lastAutoFix = 0;
  let pendingJoin = null;          // true while we expect the guest to start playing but haven't seen it (autoplay blocked / reload in flight)
  let stageUnsubs = [];

  // ---------------- small helpers ----------------

  function formatTime(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return "—";
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  }

  // Projects a participant's self-reported presence { time, playing,
  // updatedAt } forward to right now, so a "Playing" person's displayed
  // timestamp keeps ticking between their ~15s presence pings.
  function projectPresence(presence) {
    if (!presence) return null;
    if (!presence.playing) return presence.time;
    return presence.time + Math.min(30, (Date.now() - presence.updatedAt) / 1000);
  }

  function matches(meta, ctx) {
    if (!meta || !ctx) return false;
    if (meta.mediaType !== ctx.mediaType || String(meta.id) !== String(ctx.id)) return false;
    if (ctx.mediaType === "tv") return String(meta.season) === String(ctx.season) && String(meta.episode) === String(ctx.episode);
    return true;
  }

  function watchPath(meta) {
    return meta.mediaType === "tv"
      ? `/watch/series/${meta.id}/${meta.season}/${meta.episode}`
      : `/watch/movie/${meta.id}`;
  }

  function shareLink(roomId) {
    return `${location.origin}/party/${roomId}`;
  }

  // Uses the app's client-side router if it's available so navigating
  // doesn't trigger a full page reload; falls back to a normal navigation.
  function goTo(path) {
    if (window.vidoraNavigate) window.vidoraNavigate(path);
    else location.href = path;
  }

  function escHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    const chars = parts.map((w) => w[0]).join("").toUpperCase();
    return chars || "?";
  }

  // Deterministic hue per participant id, so avatar colors stay stable.
  const AVATAR_HUES = [340, 265, 205, 160, 40, 20, 190];
  function avatarColor(id) {
    let h = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `hsl(${AVATAR_HUES[h % AVATAR_HUES.length]}deg 58% 54%)`;
  }

  // A participant's photo (if they have a profile) takes priority over the
  // host crown / initials fallback. The src is escaped: it comes from other
  // people's browsers.
  function avatarInner(p) {
    if (p.avatar) return `<img src="${escHtml(p.avatar)}" alt="" />`;
    if (p.host) return VD.icon("crown", { size: 14 });
    return escHtml(initials(p.name));
  }

  function participantListHTML(list) {
    if (!list.length) return `<p class="party-empty-note">Waiting for people to join…</p>`;
    const hostEntry = list.find((p) => p.host);
    const hostTime = hostEntry ? projectPresence(hostEntry.presence) : null;
    return `<ul class="party-people">${list.map((p) => {
      const t = projectPresence(p.presence);
      const stale = !p.presence || Date.now() - p.presence.updatedAt > 40000;
      const drift = !p.host && t != null && hostTime != null ? Math.abs(t - hostTime) : null;
      const offSync = drift != null && drift > BANNER_DRIFT_SEC + 2;
      const timeClasses = ["party-person-time", stale && "stale", offSync && "offsync"].filter(Boolean).join(" ");
      return `
      <li class="party-person">
        <span class="party-avatar" style="background:${avatarColor(p.id)}">${avatarInner(p)}</span>
        <span class="party-person-name">${escHtml(p.name)}</span>
        ${p.host ? `<span class="party-person-tag">Host</span>` : ""}
        <span class="${timeClasses}" title="${offSync ? `${Math.round(drift)}s behind the host` : ""}">${formatTime(t)}</span>
      </li>`;
    }).join("")}</ul>`;
  }

  // Shown in the create/join modal in place of a name field once a local
  // profile exists — the person's identity is already decided.
  function identityChipHTML(verb) {
    const profile = typeof VidoraProfile !== "undefined" && VidoraProfile.getProfile();
    if (!profile) return "";
    return `
      <div class="party-profile-chip">
        ${profile.image ? `<img src="${escHtml(profile.image)}" alt="" />` : VD.icon("user", { size: 16 })}
        <span>${verb} as <strong>${escHtml(profile.name)}</strong></span>
      </div>`;
  }

  function flashCopied(btn, label) {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = label;
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("copied");
    }, 1600);
  }

  function refreshParticipants() {
    if (!currentContainer) return;
    const listEl = currentContainer.querySelector("#ptyPeople");
    if (listEl) listEl.innerHTML = participantListHTML(VidoraParty.getParticipants());
    const countEl = currentContainer.querySelector(".party-count");
    if (countEl) countEl.textContent = String(VidoraParty.getParticipants().length);
  }

  // ---------------- guest: following the host ----------------

  function stage() { return currentCtx && currentCtx.stage; }

  // What the player should be doing right now, or null if there's nothing
  // to follow (no state yet, or the host's video has finished).
  function hostTarget() {
    const p = VidoraParty.getHostPosition();
    if (!p || p.ended) return null;
    return { time: p.time, playing: p.playing };
  }

  function guestIsPlaying() {
    const live = VidoraPlayer.getLive();
    return live && !live.stale ? live.playing : null;
  }

  // Applies a host state that just arrived.
  function followHost(state) {
    const st = stage();
    if (!st || !VidoraParty.isGuest()) return;

    if (state.event === "ended") { pendingJoin = null; updateSyncBanner(); return; }

    const playing = typeof state.playing === "boolean" ? state.playing : state.event !== "pause";
    // A heartbeat only re-anchors the position. If the host's play state
    // changed, treat it as a command even though it was coalesced into a
    // "timeupdate" on its way here.
    const heartbeat = state.event === "timeupdate" && lastAppliedPlaying === playing;
    lastAppliedPlaying = playing;

    if (heartbeat) { driftCheck(); updateSyncBanner(); return; }

    const t = hostTarget();
    if (!t) return;

    if (st.isNative()) {
      st.sync(hostTarget, { tolerance: 1 });
    } else {
      // Embed: don't reload for a command that changes nothing (e.g. the
      // guest is already playing within a second or two of the host).
      const live = VidoraPlayer.getLive();
      const alreadyThere = live && !live.stale && live.playing === t.playing &&
        Math.abs(live.time - t.time) < SKIP_RELOAD_WITHIN_SEC;
      if (!alreadyThere) {
        st.sync(hostTarget);
        if (t.playing) pendingJoin = true; // can't confirm a cross-origin autoplay took hold; see tick()
      }
    }
    updateSyncBanner();
  }

  // Corrects a PLAYING guest that has strayed from a PLAYING host.
  function driftCheck() {
    const st = stage();
    const t = hostTarget();
    const live = VidoraPlayer.getLive();
    if (!st || !t || !live || live.stale || !t.playing || !live.playing) return;
    if (Date.now() - lastAutoFix < AUTOFIX_COOLDOWN_MS) return;
    const limit = st.isNative() ? NATIVE_DRIFT_SEC : IFRAME_DRIFT_SEC;
    if (Math.abs(live.time - t.time) <= limit) return;
    lastAutoFix = Date.now();
    st.sync(hostTarget, { tolerance: 1 });
  }

  // The "Sync now" button / tapping the join banner.
  function syncNow() {
    const st = stage();
    if (!st) return;
    pendingJoin = null;
    lastAutoFix = Date.now();
    const t = hostTarget();
    if (!t) { VD.toast("The host hasn't started playback yet."); return; }
    st.sync(hostTarget, { tolerance: 0, immediate: true });
    if (t.playing && !st.isNative()) pendingJoin = true;
    updateSyncBanner();
  }

  // Updates the status line + sync banner in place, without a full render().
  function updateSyncBanner() {
    if (!currentContainer || !VidoraParty.isGuest()) return;
    const p = VidoraParty.getHostPosition();

    const statusEl = currentContainer.querySelector("#ptyHostStatus");
    if (statusEl) {
      statusEl.textContent = !p ? "Host: waiting to start"
        : p.ended ? "Host: finished watching"
        : `Host: ${p.playing ? "Playing" : "Paused"}`;
    }

    const modeEl = currentContainer.querySelector("#ptyMode");
    const st = stage();
    if (modeEl && st) {
      modeEl.textContent = st.isNative() ? "Live sync" : "Auto-sync (reloads the player)";
      modeEl.classList.toggle("live", st.isNative());
    }

    const bannerEl = currentContainer.querySelector("#ptyResync");
    if (!bannerEl) return;
    if (!p || p.ended) { bannerEl.style.display = "none"; return; }

    const live = VidoraPlayer.getLive();
    const guestKnown = live && !live.stale;
    const drift = guestKnown ? Math.abs(live.time - p.time) : Infinity;
    const stateMismatch = guestKnown && live.playing !== p.playing;
    const needsSync = Boolean(pendingJoin) || stateMismatch || (guestKnown && drift > BANNER_DRIFT_SEC);

    if (!needsSync) { bannerEl.style.display = "none"; return; }

    const msgEl = bannerEl.querySelector("#ptyResyncMsg");
    if (msgEl) {
      msgEl.textContent = pendingJoin
        ? "Host is playing — tap to join in"
        : stateMismatch
          ? (p.playing ? "Host is playing — tap to catch up" : "Host paused — tap to match them")
          : `You're ${Math.round(drift)}s ${live.time < p.time ? "behind" : "ahead"} — tap to jump to their spot`;
    }
    bannerEl.style.display = "flex";
  }

  // ---------------- views ----------------
  function renderHostPanel() {
    const roomId = VidoraParty.getRoomId();
    const pass = VidoraParty.getPassword();
    currentContainer.innerHTML = `
      <div class="party-card">
        <div class="party-card-glow" aria-hidden="true"></div>
        <div class="party-top">
          <div class="party-top-left">
            <span class="party-live-dot" aria-hidden="true"></span>
            <h4>Watch party</h4>
          </div>
          <span class="party-role-tag host">Hosting</span>
        </div>
        <p class="party-sub">Share the code below. Everyone watches in sync — you're the only one who controls playback.</p>

        <div class="party-invite">
          <div class="party-invite-row">
            <div class="party-invite-text">
              <span class="party-invite-label">Room code</span>
              <span class="party-invite-value party-invite-code">${escHtml(roomId.toUpperCase())}</span>
            </div>
            <button class="party-copy-btn" id="ptyCopyLink" type="button">Copy link</button>
          </div>
          ${pass ? `
          <div class="party-invite-row">
            <div class="party-invite-text">
              <span class="party-invite-label">Password</span>
              <span class="party-invite-value">${escHtml(pass)}</span>
            </div>
            <button class="party-copy-btn" id="ptyCopyPass" type="button">Copy</button>
          </div>` : ""}
        </div>

        <div class="party-section">
          <div class="party-section-head">
            <span>In this party</span>
            <span class="party-count">${VidoraParty.getParticipants().length}</span>
          </div>
          <div id="ptyPeople">${participantListHTML(VidoraParty.getParticipants())}</div>
        </div>

        <div class="party-actions">
          <button class="btn btn-danger btn-sm" id="ptyEnd" type="button">End party</button>
        </div>
      </div>`;

    currentContainer.querySelector("#ptyCopyLink").addEventListener("click", (e) => {
      navigator.clipboard.writeText(shareLink(roomId)).then(() => flashCopied(e.currentTarget, "Copied ✓"));
    });
    const copyPass = currentContainer.querySelector("#ptyCopyPass");
    if (copyPass) copyPass.addEventListener("click", (e) => {
      navigator.clipboard.writeText(pass).then(() => flashCopied(e.currentTarget, "Copied ✓"));
    });
    currentContainer.querySelector("#ptyEnd").addEventListener("click", () => {
      VidoraParty.leaveRoom();
      VD.toast("Party ended.");
    });
  }

  function renderGuestBar() {
    lastAppliedPlaying = (VidoraParty.getHostPosition() || {}).playing ?? null;
    pendingJoin = null;

    const host = VidoraParty.getParticipants().find((p) => p.host);
    currentContainer.innerHTML = `
      <div class="party-card guest">
        <div class="party-card-glow" aria-hidden="true"></div>
        <div class="party-top">
          <div class="party-top-left">
            <span class="party-live-dot" aria-hidden="true"></span>
            <h4>Watch party</h4>
          </div>
          <span class="party-role-tag guest">Watching along</span>
        </div>
        <p class="party-sub"><strong>${escHtml(host ? host.name : "Host")}</strong> is in control — your player follows their play, pause and seek automatically.</p>
        <p class="party-status"><span id="ptyHostStatus">Host: —</span> · <span class="party-mode" id="ptyMode"></span></p>

        <div class="party-resync" id="ptyResync" style="display:none;">
          <span id="ptyResyncMsg"></span>
          <button class="btn btn-primary btn-sm" id="ptyResyncBtn" type="button">Sync now</button>
        </div>

        <div class="party-section">
          <div class="party-section-head">
            <span>In this party</span>
            <span class="party-count">${VidoraParty.getParticipants().length}</span>
          </div>
          <div id="ptyPeople">${participantListHTML(VidoraParty.getParticipants())}</div>
        </div>

        <div class="party-actions">
          <button class="btn btn-ghost btn-sm" id="ptyLeave" type="button">Leave party</button>
        </div>
      </div>`;

    currentContainer.querySelector("#ptyLeave").addEventListener("click", () => {
      VidoraParty.leaveRoom();
    });
    currentContainer.querySelector("#ptyResyncBtn").addEventListener("click", syncNow);

    updateSyncBanner();
  }

  function renderStartButton() {
    currentContainer.innerHTML = `
      <div class="party-promo">
        <div class="party-promo-icon" aria-hidden="true">${VD.icon("users", { size: 22 })}</div>
        <div class="party-promo-text">
          <h4>Watch this together</h4>
          <p>Start a watch party and invite friends — everyone's player stays in sync with yours.</p>
        </div>
        <button class="btn btn-primary party-start-btn" id="ptyStart" type="button">
          ${VD.icon("play", { size: 16 })} Start a watch party
        </button>
      </div>`;
    currentContainer.querySelector("#ptyStart").addEventListener("click", openStartModal);
  }

  function openStartModal() {
    const ctx = currentCtx;
    const hasProfile = typeof VidoraProfile !== "undefined" && VidoraProfile.hasProfile();
    const nameFieldHTML = hasProfile
      ? identityChipHTML("Hosting")
      : `<label for="ptyName">Your name</label><input type="text" id="ptyName" placeholder="Host" maxlength="20" />`;

    VD.modal({
      title: "Start a watch party",
      sub: "Friends join with a link and a password. You stay in control of playback.",
      bodyHTML: `
        ${nameFieldHTML}
        <label for="ptyPass">Room password</label>
        <input type="password" id="ptyPass" placeholder="e.g. movie-night" maxlength="24" autocomplete="off" />
      `,
      actions: [
        { id: "cancel", label: "Cancel", variant: "btn-ghost", onClick: (close) => close() },
        { id: "create", label: "Create room", variant: "btn-primary", onClick: async (close, backdrop) => {
            const nameInput = document.getElementById("ptyName");
            const name = nameInput ? nameInput.value.trim() || "Host" : undefined; // undefined → VidoraParty falls back to the profile name
            const pass = document.getElementById("ptyPass").value.trim();
            if (pass.length < 3) { VD.toast("Pick a password (at least 3 characters)."); return; }
            const createBtn = backdrop.querySelector('[data-action="create"]');
            if (createBtn) { createBtn.disabled = true; createBtn.textContent = "Creating…"; }
            try {
              await VidoraParty.createRoom(ctx, pass, name);
              close();
              VD.toast("Party created — share the link with friends.");
            } catch (err) {
              if (createBtn) { createBtn.disabled = false; createBtn.textContent = "Create room"; }
              VD.toast(err.message || "Couldn't start the party.");
            }
          } },
      ],
    });
  }

  // ---------------- render dispatch ----------------
  function render() {
    if (!currentContainer || !currentCtx) return;

    if (VidoraParty.isHost()) {
      if (!matches(VidoraParty.getMediaMeta(), currentCtx)) {
        // The host navigated to different content while still hosting.
        // Bring the party along instead of leaving it stuck on the old title.
        VidoraParty.updateMedia(currentCtx);
        VD.toast("Party updated to follow you here.");
      }
      renderHostPanel();
      return;
    }

    if (VidoraParty.isGuest() && matches(VidoraParty.getMediaMeta(), currentCtx)) {
      renderGuestBar();
      return;
    }

    renderStartButton();
  }

  function subscribeStage(ctx) {
    stageUnsubs.forEach((fn) => fn());
    stageUnsubs = [];
    if (!ctx.stage) return;

    // A native player just took the stage (the extension injected one, or
    // the page started one). Bring it to where the party is straight away.
    stageUnsubs.push(ctx.stage.onNative(() => {
      pendingJoin = null;
      if (VidoraParty.isGuest() && matches(VidoraParty.getMediaMeta(), ctx)) {
        if (hostTarget()) ctx.stage.sync(hostTarget, { tolerance: 0 });
      } else if (VidoraParty.isHost()) {
        VidoraParty.primeFromLive();
      }
      updateSyncBanner();
    }));

    stageUnsubs.push(ctx.stage.onStatus((status) => {
      if (!VidoraParty.isGuest()) return;
      if (status === "blocked") { pendingJoin = true; updateSyncBanner(); }
      if (status === "unblocked") {
        pendingJoin = null;
        if (hostTarget()) ctx.stage.sync(hostTarget, { tolerance: 0 });
        updateSyncBanner();
      }
    }));
  }

  function mount(container, ctx) {
    currentContainer = container;
    currentCtx = ctx;
    lastAutoFix = 0;
    subscribeStage(ctx);
    render();
  }

  function unmount() {
    stageUnsubs.forEach((fn) => fn());
    stageUnsubs = [];
    currentContainer = null;
    currentCtx = null;
    pendingJoin = null;
  }

  // The watch page's identity changed without a re-render (an embed player
  // auto-advanced to the next episode). If we're hosting, the party follows.
  function updateContext(patch) {
    if (!currentCtx) return;
    currentCtx = { ...currentCtx, ...patch };
    if (VidoraParty.isHost()) render();
  }

  // ---------------- global listeners (registered once) ----------------
  VidoraParty.on("participants", refreshParticipants);

  // Purely visual + local: ticks the people list's timestamps, refreshes the
  // banner, and runs the guest's drift check. No network work of its own.
  setInterval(() => {
    if (!currentContainer || !VidoraParty.inRoom()) return;
    refreshParticipants();
    if (VidoraParty.isGuest()) {
      // A reload we triggered is confirmed once the guest's player reports playing.
      if (pendingJoin && guestIsPlaying() === true && (!stage() || !stage().isNative())) pendingJoin = null;
      driftCheck();
      updateSyncBanner();
    }
  }, 1000);

  VidoraParty.on("session", () => {
    // created / joined / resumed / left (or ended) — repaint whatever is mounted
    if (!currentContainer || !currentCtx) return;
    if (VidoraParty.isGuest() && !matches(VidoraParty.getMediaMeta(), currentCtx)) {
      goTo(watchPath(VidoraParty.getMediaMeta())); // refreshed on a different page than the party is on
      return;
    }
    render();
  });

  VidoraParty.on("media", (meta) => {
    if (!VidoraParty.isGuest()) return;
    if (currentCtx && matches(meta, currentCtx)) { render(); return; }
    VD.toast(`Following the host to “${meta.title}”…`);
    goTo(watchPath(meta));
  });

  VidoraParty.on("disconnect", (reason) => {
    VidoraParty.leaveRoom();
    VD.toast(reason || "Disconnected from the party.");
  });

  VidoraParty.on("state", (state) => {
    if (!VidoraParty.isGuest() || !currentCtx) return;
    if (!matches(VidoraParty.getMediaMeta(), currentCtx)) return;
    followHost(state);
  });

  // ---------------- join page (/party/:roomId) ----------------
  function renderJoinPage(container, roomId) {
    // Already in this very room (e.g. opened the invite link again, or the
    // session was resumed after a refresh): just go watch.
    const code = String(roomId).toLowerCase();
    const existing = VidoraParty.getMediaMeta();
    if (VidoraParty.inRoom() && VidoraParty.getRoomId() === code && existing) {
      goTo(watchPath(existing));
      return;
    }

    container.innerHTML = `<div class="empty-state"><h3>Joining party…</h3></div>`;
    const hasProfile = typeof VidoraProfile !== "undefined" && VidoraProfile.hasProfile();
    const nameFieldHTML = hasProfile
      ? identityChipHTML("Joining")
      : `<label for="jName">Your name</label><input type="text" id="jName" placeholder="Guest" maxlength="20" />`;

    VD.modal({
      title: "Join watch party",
      sub: `Room ${escHtml(roomId.toUpperCase())} — enter the password your host shared.`,
      bodyHTML: `
        ${nameFieldHTML}
        <label for="jPass">Password</label>
        <input type="password" id="jPass" placeholder="Room password" maxlength="24" autocomplete="off" />
        <div class="vd-field-error" id="jError" style="display:none;"></div>
      `,
      // closing the dialog any other way (✕, Esc, clicking outside) used to
      // leave the page stuck on "Joining party…"
      onDismiss: () => goTo("/"),
      actions: [
        { id: "cancel", label: "Not now", variant: "btn-ghost", onClick: (close) => { close(); goTo("/"); } },
        { id: "join", label: "Join", variant: "btn-primary", onClick: async (close, backdrop) => {
            const nameInput = document.getElementById("jName");
            const name = nameInput ? nameInput.value.trim() || "Guest" : undefined; // undefined → VidoraParty falls back to the profile name
            const pass = document.getElementById("jPass").value.trim();
            const errEl = document.getElementById("jError");
            errEl.style.display = "none";
            const joinBtn = backdrop.querySelector('[data-action="join"]');
            if (joinBtn) { joinBtn.disabled = true; joinBtn.textContent = "Joining…"; }
            try {
              const mediaMeta = await VidoraParty.joinRoom(roomId, pass, name);
              close();
              VD.toast("You're in — syncing with the host.");
              goTo(watchPath(mediaMeta));
            } catch (err) {
              if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = "Join"; }
              errEl.textContent = err.message || "Couldn't join that room.";
              errEl.style.display = "block";
            }
          } },
      ],
    });
  }

  return { mount, unmount, updateContext, renderJoinPage };
})();
