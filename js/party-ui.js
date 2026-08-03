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
 */

const PartyUI = (() => {
  let currentContainer = null;
  let currentCtx = null;
  let lastAppliedState = { event: null, time: -999 };

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

  function participantListHTML(list) {
    if (!list.length) return `<p class="party-empty-note">Waiting for people to join…</p>`;
    return `<ul class="party-people">${list.map((p) => `
      <li class="party-person">
        <span class="party-avatar" style="background:${avatarColor(p.id)}">${p.host ? VD.icon("crown", { size: 14 }) : initials(p.name)}</span>
        <span class="party-person-name">${escName(p.name)}</span>
        ${p.host ? `<span class="party-person-tag">Host</span>` : ""}
      </li>`).join("")}</ul>`;
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
    VD.modal({
      title: "Start a Watch Party",
      sub: "Friends join with a link and a password. You stay in control of playback.",
      bodyHTML: `
        <label for="ptyName">Your name</label>
        <input type="text" id="ptyName" placeholder="Host" maxlength="20" />
        <label for="ptyPass">Room password</label>
        <input type="password" id="ptyPass" placeholder="e.g. movie-night" maxlength="24" autocomplete="off" />
      `,
      actions: [
        { id: "cancel", label: "Cancel", variant: "btn-ghost", onClick: (close) => close() },
        { id: "create", label: "Create room", variant: "btn-primary", onClick: async (close, backdrop) => {
            const name = document.getElementById("ptyName").value.trim() || "Host";
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
      lastAppliedState = { event: state.event, time: state.currentTime || lastAppliedState.time };
      return;
    }

    const time = state.currentTime || 0;
    const drift = Math.abs(time - lastAppliedState.time);
    const isCommand = state.event === "play" || state.event === "pause" || state.event === "seeked";

    // Heartbeats ("timeupdate") are just a drift safety net, not a command —
    // only let one through if drift has grown large enough to be worth a
    // reload (every reload risks a blocked-autoplay prompt).
    if (!isCommand && drift < 8) return;
    // Skip near-duplicate updates so we don't reload the iframe for nothing.
    if (state.event === lastAppliedState.event && state.event !== "seeked" && drift < 2) return;

    lastAppliedState = { event: state.event, time };
    const autoplay = state.event !== "pause";
    iframe.src = currentCtx.buildSrc(time, autoplay);
  });

  // ---------------- join page (#/party/:roomId) ----------------
  function renderJoinPage(container, roomId) {
    container.innerHTML = `<div class="empty-state"><h3>Joining party…</h3></div>`;
    VD.modal({
      title: "Join Watch Party",
      sub: `Room ${roomId.toUpperCase()} — enter the password your host shared.`,
      bodyHTML: `
        <label for="jName">Your name</label>
        <input type="text" id="jName" placeholder="Guest" maxlength="20" />
        <label for="jPass">Password</label>
        <input type="password" id="jPass" placeholder="Room password" maxlength="24" autocomplete="off" />
        <div class="vd-field-error" id="jError" style="display:none;"></div>
      `,
      actions: [
        { id: "cancel", label: "Not now", variant: "btn-ghost", onClick: (close) => { close(); goTo("/"); } },
        { id: "join", label: "Join", variant: "btn-primary", onClick: async (close, backdrop) => {
            const name = document.getElementById("jName").value.trim() || "Guest";
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