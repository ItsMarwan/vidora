/**
 * VIDORA — WATCH PARTY UI
 * Wires VidoraParty + VD components into the watch pages.
 *
 * All VidoraParty listeners here are registered exactly ONCE, at module
 * load — not inside mount(). Watch pages call mount() again on every
 * navigation, and re-subscribing there used to stack up a fresh listener
 * per visit (they were never removed), so a single state broadcast could
 * trigger several redundant iframe reloads — the actual source of the
 * stutter/lag people were seeing. Instead, listeners read from
 * `currentContainer`/`currentCtx`, two module-level pointers that mount()
 * simply updates each time — so there's only ever one live listener per
 * event, no matter how many times the party UI has been mounted.
 *
 * When a local profile exists (VidoraProfile), the "your name" field is
 * replaced with a small "Hosting/Joining as ⟨name⟩" chip showing the
 * profile's name and photo — no re-typing a name every party.
 */

const PartyUI = (() => {
  let currentContainer = null;
  let currentCtx = null;
  let lastAppliedState = { event: null, time: -999 };

  const DRIFT_TOLERANCE_SEC = 1;

  // The host's last known status, as reported by Watch Party — used for the
  // "Host: Playing/Paused" status line and to work out whether the guest is
  // actually caught up. `receivedAt` lets us project forward while the host
  // keeps playing (see projectedHostTime) instead of comparing against an
  // increasingly-stale snapshot.
  let hostState = null; // { event, time, receivedAt }

  // What the GUEST's own iframe is actually reporting via its PLAYER_EVENT
  // postMessages — the ground truth for "is this browser actually in sync",
  // as opposed to `lastAppliedState` which only reflects what we last *told*
  // the iframe to load (and, for autoplay reloads, that's not a guarantee it
  // actually started — see pendingResync below).
  let guestPlayer = { time: null, playing: null };

  // Set whenever a guest-side sync reload needed autoplay (state.event !==
  // "pause"). Cross-origin embeds can't be autoplayed from a background
  // poll callback without a real user gesture, so a reload alone doesn't
  // guarantee playback actually started — this stays set until a genuine
  // "play" PLAYER_EVENT comes back from the guest's own iframe, confirming
  // it. While set, the sync banner's button is the fallback: tapping it is
  // a real click, which browsers always allow to autoplay.
  let pendingResync = null;

  function projectedHostTime() {
    if (!hostState) return null;
    const playing = hostState.event !== "pause" && hostState.event !== "ended";
    if (!playing) return hostState.time;
    return hostState.time + (Date.now() - hostState.receivedAt) / 1000;
  }

  // Updates the status line + sync banner in place, without a full render()
  // (render() would rebuild the whole card and re-seed state). Safe to call
  // often — no-ops quietly if the guest card isn't the thing on screen right
  // now (host panel, start button, or a different party altogether).
  function updateSyncBanner() {
    if (!currentContainer || !VidoraParty.isGuest()) return;
    const statusEl = currentContainer.querySelector("#ptyHostStatus");
    if (statusEl && hostState) {
      const playing = hostState.event !== "pause" && hostState.event !== "ended";
      statusEl.textContent = hostState.event === "ended" ? "Host: finished watching" : `Host: ${playing ? "Playing" : "Paused"}`;
    }

    const bannerEl = currentContainer.querySelector("#ptyResync");
    if (!bannerEl || !hostState || hostState.event === "ended") {
      if (bannerEl) bannerEl.style.display = "none";
      return;
    }

    const hostPlaying = hostState.event !== "pause";
    const target = projectedHostTime();
    const drift = guestPlayer.time != null && target != null ? Math.abs(guestPlayer.time - target) : Infinity;
    const needsSync = Boolean(pendingResync) || drift > DRIFT_TOLERANCE_SEC;

    if (!needsSync) { bannerEl.style.display = "none"; return; }

    const msgEl = bannerEl.querySelector("#ptyResyncMsg");
    if (msgEl) {
      msgEl.textContent = pendingResync
        ? "Host started playback — tap to join in"
        : hostPlaying
          ? `You're ${Math.round(drift)}s behind — tap to jump to their spot`
          : "Host paused — tap to match them";
    }
    bannerEl.style.display = "flex";
  }

  function matches(meta, ctx) {
    if (!meta || !ctx) return false;
    if (meta.mediaType !== ctx.mediaType || String(meta.id) !== String(ctx.id)) return false;
    if (ctx.mediaType === "tv") return String(meta.season) === String(ctx.season) && String(meta.episode) === String(ctx.episode);
    return true;
  }

  function shareLink(roomId) {
    return `${location.origin}/party/${roomId}`;
  }

  // Uses the app's client-side router if it's available (it will be, by
  // the time any of these run) so navigating doesn't trigger a full page
  // reload; falls back to a normal navigation otherwise.
  function goTo(path) {
    if (window.vidoraNavigate) window.vidoraNavigate(path);
    else location.href = path;
  }

  function escName(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function initials(name) {
    const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    const chars = parts.map((w) => w[0]).join("").toUpperCase();
    return chars || "?";
  }

  // Deterministic hue per participant id, so avatar colors stay stable
  // across re-renders instead of reshuffling every update.
  const AVATAR_HUES = [340, 265, 205, 160, 40, 20, 190];
  function avatarColor(id) {
    let h = 0;
    const s = String(id);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return `hsl(${AVATAR_HUES[h % AVATAR_HUES.length]}deg 58% 54%)`;
  }

  // A participant's photo (if they have a profile) takes priority over
  // the host crown / initials fallback.
  function avatarInner(p) {
    if (p.avatar) return `<img src="${p.avatar}" alt="" />`;
    if (p.host) return VD.icon("crown", { size: 14 });
    return initials(p.name);
  }

  function participantListHTML(list) {
    if (!list.length) return `<p class="party-empty-note">Waiting for people to join…</p>`;
    return `<ul class="party-people">${list.map((p) => `
      <li class="party-person">
        <span class="party-avatar" style="background:${avatarColor(p.id)}">${avatarInner(p)}</span>
        <span class="party-person-name">${escName(p.name)}</span>
        ${p.host ? `<span class="party-person-tag">Host</span>` : ""}
      </li>`).join("")}</ul>`;
  }

  // Shown in the create/join modal in place of a name field once a local
  // profile exists — the person's identity is already decided.
  function identityChipHTML(verb) {
    // Same window.VidoraProfile pitfall as party.js's resolveIdentity() —
    // see the note there. Check the bare global instead.
    const profile = typeof VidoraProfile !== "undefined" && VidoraProfile.getProfile();
    if (!profile) return "";
    return `
      <div class="party-profile-chip">
        ${profile.image ? `<img src="${escName(profile.image)}" alt="" />` : VD.icon("user", { size: 16 })}
        <span>${verb} as <strong>${escName(profile.name)}</strong></span>
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
            <h4>Watch Party</h4>
          </div>
          <span class="party-role-tag host">Hosting</span>
        </div>
        <p class="party-sub">Share the code below. Everyone watches in sync — you're the only one who controls playback.</p>

        <div class="party-invite">
          <div class="party-invite-row">
            <div class="party-invite-text">
              <span class="party-invite-label">Room code</span>
              <span class="party-invite-value party-invite-code">${escName(roomId.toUpperCase())}</span>
            </div>
            <button class="party-copy-btn" id="ptyCopyLink" type="button">Copy link</button>
          </div>
          <div class="party-invite-row">
            <div class="party-invite-text">
              <span class="party-invite-label">Password</span>
              <span class="party-invite-value">${escName(pass)}</span>
            </div>
            <button class="party-copy-btn" id="ptyCopyPass" type="button">Copy</button>
          </div>
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
    currentContainer.querySelector("#ptyCopyPass").addEventListener("click", (e) => {
      navigator.clipboard.writeText(pass).then(() => flashCopied(e.currentTarget, "Copied ✓"));
    });
    currentContainer.querySelector("#ptyEnd").addEventListener("click", () => {
      VidoraParty.leaveRoom();
      VD.toast("Party ended.");
      render();
    });
  }

  function renderGuestBar() {
    // Seed drift-tracking from whatever state we already have, so the
    // very first live update after mounting doesn't get treated as a
    // giant, reload-triggering jump.
    const seed = VidoraParty.getLastState();
    lastAppliedState = seed ? { event: seed.event, time: seed.currentTime || 0 } : { event: null, time: -999 };
    hostState = seed ? { event: seed.event, time: seed.currentTime || 0, receivedAt: Date.now() } : null;
    guestPlayer = { time: null, playing: null };
    pendingResync = null;

    const host = VidoraParty.getParticipants().find((p) => p.host);
    currentContainer.innerHTML = `
      <div class="party-card guest">
        <div class="party-card-glow" aria-hidden="true"></div>
        <div class="party-top">
          <div class="party-top-left">
            <span class="party-live-dot" aria-hidden="true"></span>
            <h4>Watch Party</h4>
          </div>
          <span class="party-role-tag guest">Watching along</span>
        </div>
        <p class="party-sub"><strong>${escName(host ? host.name : "Host")}</strong> is in control — your player follows their play, pause and seek automatically.</p>
        <p class="party-status" id="ptyHostStatus">Host: —</p>

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
      render();
    });
    currentContainer.querySelector("#ptyResyncBtn").addEventListener("click", () => {
      if (!hostState || !currentCtx) return;
      const iframe = currentCtx.getIframe();
      const hostPlaying = hostState.event !== "pause";
      const time = projectedHostTime() ?? hostState.time;
      if (iframe) iframe.src = currentCtx.buildSrc(time, hostPlaying);
      lastAppliedState = { event: hostState.event, time };
      // Same autoplay caveat as the automatic path — except this reload runs
      // straight from a real click, so browsers will actually allow it, and
      // there's nothing left to fall back on.
      pendingResync = null;
      if (!hostPlaying) guestPlayer = { time, playing: false };
      updateSyncBanner();
    });

    updateSyncBanner();
  }

  function renderStartButton() {
    currentContainer.innerHTML = `
      <div class="party-promo">
        <div class="party-promo-icon" aria-hidden="true">${VD.icon("users", { size: 22 })}</div>
        <div class="party-promo-text">
          <h4>Watch this together</h4>
          <p>Start a Watch Party and invite friends — everyone's player stays in sync with yours.</p>
        </div>
        <button class="btn btn-primary party-start-btn" id="ptyStart" type="button">
          ${VD.icon("play", { size: 16 })} Start a Watch Party
        </button>
      </div>`;
    currentContainer.querySelector("#ptyStart").addEventListener("click", openStartModal);
  }

  function openStartModal() {
    const ctx = currentCtx;
    // Same window.VidoraProfile pitfall — see resolveIdentity() in party.js.
    const hasProfile = typeof VidoraProfile !== "undefined" && VidoraProfile.hasProfile();
    const nameFieldHTML = hasProfile
      ? identityChipHTML("Hosting")
      : `<label for="ptyName">Your name</label><input type="text" id="ptyName" placeholder="Host" maxlength="20" />`;

    VD.modal({
      title: "Start a Watch Party",
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
            if (!pass) { VD.toast("Pick a password first."); return; }
            const createBtn = backdrop.querySelector('[data-action="create"]');
            if (createBtn) { createBtn.disabled = true; createBtn.textContent = "Creating…"; }
            try {
              await VidoraParty.createRoom(ctx, pass, name);
              close();
              render();
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
        // Bring the party along instead of leaving it stuck on the old
        // title with nobody able to see or control it.
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

  function mount(container, ctx) {
    currentContainer = container;
    currentCtx = ctx;
    render();
  }

  // ---------------- global listeners (registered once) ----------------
  VidoraParty.on("participants", refreshParticipants);

  VidoraParty.on("media", (meta) => {
    if (!VidoraParty.isGuest()) return;
    if (currentCtx && matches(meta, currentCtx)) { render(); return; }
    VD.toast(`Following the host to “${meta.title}”…`);
    goTo(meta.mediaType === "tv"
      ? `/watch/series/${meta.id}/${meta.season}/${meta.episode}`
      : `/watch/movie/${meta.id}`);
  });

  VidoraParty.on("disconnect", (reason) => {
    VidoraParty.leaveRoom();
    VD.toast(reason || "Disconnected from the party.");
    render();
  });

  VidoraParty.on("state", (state) => {
    if (!VidoraParty.isGuest() || !currentCtx) return;
    const iframe = currentCtx.getIframe();
    if (!iframe) return;

    // The host's video ending isn't something to "sync" by reloading the
    // guest's iframe — there's no meaningful position to resume, and
    // `autoplay = state.event !== "pause"` previously evaluated true here,
    // which reloaded the guest's player with autoplay ON right as the video
    // finished, effectively restarting it. Just note it happened and leave
    // the guest's own player to finish on its own.
    if (state.event === "ended") {
      hostState = { event: "ended", time: state.currentTime || (hostState ? hostState.time : 0), receivedAt: Date.now() };
      lastAppliedState = { event: state.event, time: hostState.time };
      pendingResync = null;
      updateSyncBanner();
      return;
    }

    const time = state.currentTime || 0;
    hostState = { event: state.event, time, receivedAt: Date.now() };

    const drift = Math.abs(time - lastAppliedState.time);
    const isCommand = state.event === "play" || state.event === "pause" || state.event === "seeked";

    // Max allowed drift before we force a resync. Commands (play/pause/seek)
    // always apply immediately regardless of drift; heartbeats ("timeupdate",
    // sent every 2 minutes per the host's HEARTBEAT_MS) are just a periodic
    // safety-net check — only worth a reload once drift exceeds this.
    // Skip near-duplicate updates so we don't reload the iframe for nothing
    // (e.g. the same "play" arriving twice in a row with ~identical time).
    // Kept at the same tolerance so this can't silently widen the effective
    // drift window above DRIFT_TOLERANCE_SEC.
    const shouldApply = isCommand || drift >= DRIFT_TOLERANCE_SEC;
    const isDuplicate = state.event === lastAppliedState.event && state.event !== "seeked" && drift < DRIFT_TOLERANCE_SEC;

    if (shouldApply && !isDuplicate) {
      lastAppliedState = { event: state.event, time };
      const autoplay = state.event !== "pause";
      iframe.src = currentCtx.buildSrc(time, autoplay);
      if (autoplay) {
        // Can't confirm a cross-origin autoplay actually took hold from here
        // — see the pendingResync/updateSyncBanner comments above. Cleared
        // once a real "play" PLAYER_EVENT comes back from this iframe.
        pendingResync = { time };
      } else {
        // Landing on a paused frame is never blocked by autoplay policy, so
        // this one we can trust immediately — avoids a spurious "out of
        // sync" flash while waiting for the reloaded iframe's first event.
        pendingResync = null;
        guestPlayer = { time, playing: false };
      }
    }

    updateSyncBanner();
  });

  // Ground-truth read of the GUEST's own iframe (not the host's) — confirms
  // whether an autoplay reload actually started, and feeds the live drift
  // check in updateSyncBanner. Registered once; cheap no-op unless the
  // guest card is actually mounted and there's a hostState to compare to.
  window.addEventListener("message", (event) => {
    if (!VidoraParty.isGuest()) return;
    let data;
    try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch { return; }
    if (!data || data.type !== "PLAYER_EVENT") return;
    const e = data.data || {};
    if (typeof e.currentTime !== "number" || !Number.isFinite(e.currentTime)) return;
    guestPlayer = { time: e.currentTime, playing: e.event !== "pause" && e.event !== "ended" };
    if (pendingResync && e.event === "play") pendingResync = null;
    updateSyncBanner();
  });

  // ---------------- join page (#/party/:roomId) ----------------
  function renderJoinPage(container, roomId) {
    container.innerHTML = `<div class="empty-state"><h3>Joining party…</h3></div>`;
    // Same window.VidoraProfile pitfall — see resolveIdentity() in party.js.
    const hasProfile = typeof VidoraProfile !== "undefined" && VidoraProfile.hasProfile();
    const nameFieldHTML = hasProfile
      ? identityChipHTML("Joining")
      : `<label for="jName">Your name</label><input type="text" id="jName" placeholder="Guest" maxlength="20" />`;

    VD.modal({
      title: "Join Watch Party",
      sub: `Room ${roomId.toUpperCase()} — enter the password your host shared.`,
      bodyHTML: `
        ${nameFieldHTML}
        <label for="jPass">Password</label>
        <input type="password" id="jPass" placeholder="Room password" maxlength="24" autocomplete="off" />
        <div class="vd-field-error" id="jError" style="display:none;"></div>
      `,
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
              goTo(mediaMeta.mediaType === "tv"
                ? `/watch/series/${mediaMeta.id}/${mediaMeta.season}/${mediaMeta.episode}`
                : `/watch/movie/${mediaMeta.id}`);
            } catch (err) {
              if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = "Join"; }
              errEl.textContent = err.message || "Couldn't join that room.";
              errEl.style.display = "block";
            }
          } },
      ],
    });
  }

  return { mount, renderJoinPage };
})();