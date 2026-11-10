/**
 * VIDORA NATIVE MEDIA PLAYER
 * -----------------------------------------------------------
 * One <video> player with Vidora's controls, used in two places from this
 * single file:
 *   - in the browser extension (popup -> executeScript -> this file), to
 *     play a direct stream in place of the site's embed iframe; and
 *   - on the site itself (index.html loads it as a plain script and exposes
 *     window.VidoraNativePlayer), so the page can play a direct source too.
 *
 * WATCH PARTY SUPPORT — THE PLAYER PROTOCOL
 * An embed iframe can only be "synced" by reloading it. A <video> we own
 * can simply be told what to do, so this player speaks a small message
 * protocol over window.postMessage (works between the page and an
 * extension content script, which live in separate JS worlds but share the
 * window's message channel):
 *
 *   player -> page
 *     { type:'PLAYER_EVENT', data:{ event, currentTime, duration, paused,
 *                                   source, playerId } }
 *         event: play | pause | seeked | ended | timeupdate
 *         (identical to what Vidy/URPlayer embeds emit, so the host side
 *          of Watch Party and Continue Watching need no special casing)
 *     { type:'VIDORA_PLAYER_READY',  playerId, source, version }
 *     { type:'VIDORA_PLAYER_STATUS', playerId, status }
 *         status: blocked   (browser refused autoplay; user must tap)
 *                 unblocked (user tapped; page should re-sync)
 *                 error     (stream failed to load)
 *
 *   page -> player
 *     { type:'VIDORA_PLAYER_CMD', cmd, ... }
 *         play | pause | seek {time} | sync {time, playing, tolerance?}
 *         | ping | destroy
 *
 * There is only ever one live player: a new one announces READY, and any
 * other player that hears a READY with a different id tears itself down.
 * -----------------------------------------------------------
 */
(function () {
  'use strict';

  const styleCss = `
    @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

    :host {
      all: initial;
      display: block;
      width: 100%;
      height: 100%;
      font-family: 'Manrope', sans-serif;
    }

    *, *::before, *::after { box-sizing: border-box; }

    .vd-player {
      position: relative;
      width: 100%;
      height: 100%;
      background: #000;
      overflow: hidden;
      outline: none;
    }

    .vd-player video {
      width: 100%;
      height: 100%;
      display: block;
      background: #000;
      object-fit: contain;
    }

    .vd-click-catcher {
      position: absolute;
      inset: 0;
      z-index: 2;
      cursor: pointer;
    }

    .vd-center-btn {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%) scale(0.85);
      width: 74px; height: 74px;
      border-radius: 50%;
      background: rgba(10,10,12,0.55);
      border: 1px solid rgba(242,240,235,0.08);
      backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 3;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
    }
    .vd-center-btn svg { width: 30px; height: 30px; fill: #f2f0eb; }
    .vd-player.show-center-btn .vd-center-btn { opacity: 1; transform: translate(-50%, -50%) scale(1); }

    .vd-spinner {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 46px; height: 46px;
      border-radius: 50%;
      border: 3px solid rgba(242,240,235,0.15);
      border-top-color: #e8b84b;
      z-index: 4;
      opacity: 0;
      pointer-events: none;
      animation: vd-spin 0.85s linear infinite;
    }
    .vd-player.is-buffering .vd-spinner { opacity: 1; }
    @keyframes vd-spin { to { transform: translate(-50%, -50%) rotate(360deg); } }

    .vd-controls {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      padding: 10px 16px 14px;
      background: linear-gradient(0deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.35) 60%, transparent 100%);
      z-index: 3;
      display: flex;
      flex-direction: column;
      gap: 8px;
      opacity: 1;
      transform: translateY(0);
      transition: opacity 0.28s ease, transform 0.28s ease;
    }

    .vd-player.controls-hidden .vd-controls { opacity: 0; pointer-events: none; transform: translateY(4px); }
    .vd-player.controls-hidden { cursor: none; }

    .vd-progress-wrap {
      position: relative;
      height: 16px;
      display: flex;
      align-items: center;
      cursor: pointer;
      touch-action: none;
    }
    .vd-progress-track {
      position: relative;
      width: 100%;
      height: 4px;
      border-radius: 999px;
      background: rgba(242,240,235,0.18);
      overflow: hidden;
      transition: height 0.12s ease;
    }
    .vd-progress-wrap:hover .vd-progress-track,
    .vd-progress-wrap.scrubbing .vd-progress-track { height: 6px; }
    .vd-progress-buffered {
      position: absolute; top: 0; left: 0; height: 100%;
      background: rgba(242,240,235,0.32); border-radius: 999px; width: 0%;
    }
    .vd-progress-filled {
      position: absolute; top: 0; left: 0; height: 100%;
      background: #e8b84b; border-radius: 999px; width: 0%;
    }
    .vd-progress-handle {
      position: absolute; top: 50%; left: 0%;
      width: 13px; height: 13px; border-radius: 50%;
      background: #e8b84b;
      box-shadow: 0 2px 6px rgba(0,0,0,0.5);
      transform: translate(-50%, -50%) scale(0);
      transition: transform 0.12s ease;
    }
    .vd-progress-wrap:hover .vd-progress-handle,
    .vd-progress-wrap.scrubbing .vd-progress-handle { transform: translate(-50%, -50%) scale(1); }

    .vd-scrub-tooltip {
      position: absolute;
      bottom: 20px;
      transform: translateX(-50%);
      background: #1d1c22;
      border: 1px solid rgba(242,240,235,0.08);
      color: #f2f0eb;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      padding: 3px 7px;
      border-radius: 4px;
      pointer-events: none;
      opacity: 0;
      white-space: nowrap;
      box-shadow: 0 8px 18px rgba(0,0,0,0.5);
    }
    .vd-progress-wrap:hover .vd-scrub-tooltip,
    .vd-progress-wrap.scrubbing .vd-scrub-tooltip { opacity: 1; }

    .vd-row { display: flex; align-items: center; gap: 4px; }
    .vd-row .vd-spacer { flex: 1; }

    .vd-btn {
      background: transparent; border: none; color: #f2f0eb;
      width: 34px; height: 34px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; flex: none;
      transition: background 0.15s ease, transform 0.1s ease;
    }
    .vd-btn:hover { background: rgba(242,240,235,0.12); }
    .vd-btn:active { transform: scale(0.92); }
    .vd-btn svg { width: 19px; height: 19px; fill: #f2f0eb; }
    .vd-btn:focus-visible { outline: 2px solid #e8b84b; outline-offset: 1px; }

    .vd-time {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px; color: #b8b5bd; letter-spacing: 0.01em;
      padding: 0 4px; user-select: none; white-space: nowrap;
    }

    .vd-volume { display: flex; align-items: center; gap: 2px; }
    .vd-volume-track-wrap {
      width: 0px; overflow: hidden; transition: width 0.18s ease;
      display: flex; align-items: center;
    }
    .vd-volume:hover .vd-volume-track-wrap,
    .vd-volume.active .vd-volume-track-wrap { width: 74px; }
    .vd-volume-track {
      position: relative; width: 64px; height: 3px; border-radius: 999px;
      background: rgba(242,240,235,0.18); margin-left: 6px; cursor: pointer;
    }
    .vd-volume-filled {
      position: absolute; top: 0; left: 0; height: 100%;
      background: #f2f0eb; border-radius: 999px; width: 100%;
    }
    .vd-volume-handle {
      position: absolute; top: 50%; left: 100%;
      width: 11px; height: 11px; border-radius: 50%;
      background: #f2f0eb; transform: translate(-50%, -50%);
    }

    .vd-menu-wrap { position: relative; flex: none; }
    .vd-speed-label { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #f2f0eb; }
    .vd-menu {
      position: absolute; bottom: 44px; right: 0;
      background: #1d1c22; border: 1px solid rgba(242,240,235,0.08);
      border-radius: 6px; box-shadow: 0 18px 36px rgba(0,0,0,0.55);
      padding: 6px; min-width: 110px;
      opacity: 0; transform: translateY(6px); pointer-events: none;
      transition: opacity 0.15s ease, transform 0.15s ease;
      z-index: 5;
    }
    .vd-menu.open { opacity: 1; transform: translateY(0); pointer-events: auto; }
    .vd-menu-item {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 7px 10px; border-radius: 4px; font-size: 13px; color: #b8b5bd;
      cursor: pointer; font-family: 'JetBrains Mono', monospace;
    }
    .vd-menu-item:hover { background: rgba(242,240,235,0.08); color: #f2f0eb; }
    .vd-menu-item.active { color: #e8b84b; }
    .vd-menu-item.active::after { content: "✓"; }

    .vd-skip-flash {
      position: absolute; top: 50%; transform: translateY(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 4px;
      color: #f2f0eb; font-family: 'JetBrains Mono', monospace; font-size: 12px;
      opacity: 0; z-index: 3; pointer-events: none;
    }
    .vd-skip-flash svg { width: 26px; height: 26px; fill: #f2f0eb; }
    .vd-skip-flash.left { left: 8%; }
    .vd-skip-flash.right { right: 8%; }
    .vd-skip-flash.flash { animation: vd-skip-pop 0.55s ease; }
    @keyframes vd-skip-pop {
      0% { opacity: 0; transform: translateY(-50%) scale(0.85); }
      25% { opacity: 1; transform: translateY(-50%) scale(1); }
      75% { opacity: 1; }
      100% { opacity: 0; }
    }

    .vd-player:focus-visible { box-shadow: inset 0 0 0 2px #e8b84b; }

    /* Shown when the browser refuses to autoplay a party sync (needs a tap),
       or when the video can't be played at all. */
    .vd-overlay {
      position: absolute; inset: 0; z-index: 6;
      display: none; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
      background: rgba(0,0,0,0.55); text-align: center; padding: 20px;
    }
    .vd-player.show-overlay .vd-overlay { display: flex; }
    .vd-overlay-btn {
      background: #e8b84b; color: #14120d; border: none; border-radius: 999px;
      padding: 12px 22px; font: 700 14px 'Manrope', sans-serif; cursor: pointer;
      display: inline-flex; align-items: center; gap: 8px;
    }
    .vd-overlay-btn svg { width: 18px; height: 18px; fill: #14120d; }
    .vd-overlay-btn:focus-visible { outline: 2px solid #f2f0eb; outline-offset: 2px; }
    .vd-overlay-msg { color: #f2f0eb; font: 500 13px 'Manrope', sans-serif; max-width: 320px; line-height: 1.5; }
    .vd-player.overlay-error .vd-overlay-btn { display: none; }
  `;

  const markup = `
    <div class="vd-player" id="vdPlayer" tabindex="0">
      <video id="vdVideo" playsinline preload="metadata"></video>

      <div class="vd-click-catcher" id="vdClickCatcher"></div>

      <div class="vd-spinner" id="vdSpinner"></div>

      <div class="vd-overlay" id="vdOverlay">
        <button class="vd-overlay-btn" id="vdOverlayBtn" type="button">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          <span id="vdOverlayLabel">Tap to join the party</span>
        </button>
        <div class="vd-overlay-msg" id="vdOverlayMsg"></div>
      </div>

      <div class="vd-skip-flash left" id="vdFlashLeft">
        <svg viewBox="0 0 24 24"><path d="M11 6V2L4 8l7 6v-4c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H3c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/></svg>
        <span>10s</span>
      </div>
      <div class="vd-skip-flash right" id="vdFlashRight">
        <svg viewBox="0 0 24 24"><path d="M13 6V2l7 6-7 6v-4c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6h2c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8z"/></svg>
        <span>10s</span>
      </div>

      <div class="vd-center-btn" id="vdCenterBtn">
        <svg id="vdCenterIcon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
      </div>

      <div class="vd-controls" id="vdControls">
        <div class="vd-progress-wrap" id="vdProgressWrap">
          <div class="vd-progress-track">
            <div class="vd-progress-buffered" id="vdBuffered"></div>
            <div class="vd-progress-filled" id="vdFilled"></div>
            <div class="vd-progress-handle" id="vdHandle"></div>
          </div>
          <div class="vd-scrub-tooltip" id="vdScrubTooltip">0:00</div>
        </div>

        <div class="vd-row">
          <button class="vd-btn" id="vdPlayBtn" aria-label="Play">
            <svg id="vdPlayIcon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </button>

          <button class="vd-btn" id="vdBackBtn" aria-label="Back 10 seconds">
            <svg viewBox="0 0 24 24"><path d="M11 6V2L4 8l7 6v-4c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6H3c0 4.4 3.6 8 8 8s8-3.6 8-8-3.6-8-8-8z"/></svg>
          </button>
          <button class="vd-btn" id="vdFwdBtn" aria-label="Forward 10 seconds">
            <svg viewBox="0 0 24 24"><path d="M13 6V2l7 6-7 6v-4c-3.3 0-6 2.7-6 6s2.7 6 6 6 6-2.7 6-6h2c0 4.4-3.6 8-8 8s-8-3.6-8-8 3.6-8 8-8z"/></svg>
          </button>

          <div class="vd-volume" id="vdVolumeWrap">
            <button class="vd-btn" id="vdMuteBtn" aria-label="Mute">
              <svg id="vdVolIcon" viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
            </button>
            <div class="vd-volume-track-wrap">
              <div class="vd-volume-track" id="vdVolTrack">
                <div class="vd-volume-filled" id="vdVolFilled"></div>
                <div class="vd-volume-handle" id="vdVolHandle"></div>
              </div>
            </div>
          </div>

          <div class="vd-time"><span id="vdCurrentTime">0:00</span> / <span id="vdDuration">0:00</span></div>

          <div class="vd-spacer"></div>

          <div class="vd-menu-wrap">
            <button class="vd-btn vd-speed-label" id="vdSpeedBtn" aria-label="Playback speed">1x</button>
            <div class="vd-menu" id="vdSpeedMenu">
              <div class="vd-menu-item" data-speed="0.5">0.5x</div>
              <div class="vd-menu-item" data-speed="0.75">0.75x</div>
              <div class="vd-menu-item active" data-speed="1">1x</div>
              <div class="vd-menu-item" data-speed="1.25">1.25x</div>
              <div class="vd-menu-item" data-speed="1.5">1.5x</div>
              <div class="vd-menu-item" data-speed="2">2x</div>
            </div>
          </div>

          <button class="vd-btn" id="vdFullscreenBtn" aria-label="Fullscreen">
            <svg id="vdFsIcon" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
          </button>
        </div>
      </div>
    </div>
  `;

  const ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
  const ICON_PAUSE = '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>';
  const ICON_VOL_ON = '<path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
  const ICON_VOL_MUTE = '<path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.94 8.94 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/>';
  const ICON_FS_ENTER = '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>';
  const ICON_FS_EXIT = '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>';


  // ======================================================================
  // protocol plumbing
  // ======================================================================
  const PROTOCOL_VERSION = 1;
  const IS_EXTENSION = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.onMessage);
  const SOURCE = IS_EXTENSION ? 'ext' : 'page';

  function post(msg) {
    try { window.postMessage(msg, '*'); } catch (err) { /* nothing listening / detached */ }
  }

  function parseMessage(ev) {
    if (ev.source !== window) return null;
    let d = ev.data;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch { return null; }
    }
    return d && typeof d === 'object' ? d : null;
  }

  let active = null; // the single live controller in this JS world

  function destroyActive() {
    if (active) { try { active.destroy(); } catch (err) { /* already gone */ } }
    active = null;
  }

  // ======================================================================
  // locating where the player goes
  // ======================================================================
  function findTargetIframe() {
    const candidates = [
      'iframe[src*="vidy.st"]',
      'iframe[src*="urplayer.net"]',
      'iframe#playerFrame',
      'iframe.player-iframe',
      'iframe[id*="player" i]',
      'iframe[class*="player" i]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function waitForIframe(timeoutMs) {
    return new Promise((resolve) => {
      const existing = findTargetIframe();
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const found = findTargetIframe();
        if (found) { observer.disconnect(); resolve(found); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(findTargetIframe()); }, timeoutMs);
    });
  }

  function removeExistingHosts(root) {
    (root || document).querySelectorAll('#vidora-custom-player-host').forEach((el) => el.remove());
  }

  // Puts `host` where the playback surface is. On the Vidora watch page
  // that's the #vidoraStage element (its iframe, if any, is replaced);
  // on any other page we fall back to swapping out a player-looking iframe.
  async function place(host, container) {
    const stage = container || document.getElementById('vidoraStage');
    if (stage) {
      stage.querySelectorAll('iframe').forEach((f) => { try { f.src = 'about:blank'; } catch (err) {} f.remove(); });
      removeExistingHosts(stage);
      stage.appendChild(host);
      return;
    }
    const iframe = await waitForIframe(5000);
    removeExistingHosts();
    if (iframe) {
      if (iframe.id) host.dataset.replacedId = iframe.id;
      if (iframe.className) host.className = iframe.className;
      iframe.replaceWith(host);
    } else {
      const fallback =
        document.getElementById('player') ||
        document.querySelector('.player-wrapper, .player-container, main') ||
        document.body;
      fallback.appendChild(host);
    }
  }

  function buildHost() {
    const host = document.createElement('div');
    host.id = 'vidora-custom-player-host';
    host.style.width = '100%';
    host.style.height = '100%';
    host.style.display = 'block';

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styleCss;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = markup;
    shadow.appendChild(wrap.firstElementChild);
    return { host, shadow };
  }

  // ======================================================================
  // the player itself
  // ======================================================================
  function wireUpPlayer(host, shadow, opts) {
    const movie = opts.movie || {};
    const playerId = `${SOURCE}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const cleanups = [];
    const listen = (target, type, fn, options) => {
      target.addEventListener(type, fn, options);
      cleanups.push(() => target.removeEventListener(type, fn, options));
    };

    const player = shadow.getElementById('vdPlayer');
    const video = shadow.getElementById('vdVideo');
    const clickCatcher = shadow.getElementById('vdClickCatcher');

    const playBtn = shadow.getElementById('vdPlayBtn');
    const playIcon = shadow.getElementById('vdPlayIcon');
    const centerIcon = shadow.getElementById('vdCenterIcon');
    const backBtn = shadow.getElementById('vdBackBtn');
    const fwdBtn = shadow.getElementById('vdFwdBtn');

    const progressWrap = shadow.getElementById('vdProgressWrap');
    const buffered = shadow.getElementById('vdBuffered');
    const filled = shadow.getElementById('vdFilled');
    const handle = shadow.getElementById('vdHandle');
    const scrubTooltip = shadow.getElementById('vdScrubTooltip');

    const currentTimeEl = shadow.getElementById('vdCurrentTime');
    const durationEl = shadow.getElementById('vdDuration');

    const volumeWrap = shadow.getElementById('vdVolumeWrap');
    const muteBtn = shadow.getElementById('vdMuteBtn');
    const volIcon = shadow.getElementById('vdVolIcon');
    const volTrack = shadow.getElementById('vdVolTrack');
    const volFilled = shadow.getElementById('vdVolFilled');
    const volHandle = shadow.getElementById('vdVolHandle');

    const speedBtn = shadow.getElementById('vdSpeedBtn');
    const speedMenu = shadow.getElementById('vdSpeedMenu');

    const fsBtn = shadow.getElementById('vdFullscreenBtn');
    const fsIcon = shadow.getElementById('vdFsIcon');

    const flashLeft = shadow.getElementById('vdFlashLeft');
    const flashRight = shadow.getElementById('vdFlashRight');

    const overlayBtn = shadow.getElementById('vdOverlayBtn');
    const overlayLabel = shadow.getElementById('vdOverlayLabel');
    const overlayMsg = shadow.getElementById('vdOverlayMsg');

    let isScrubbing = false;
    let scrubTime = 0;
    let hideTimer = null;
    let hls = null;
    let destroyed = false;
    let startApplied = false;      // the start position is applied EXACTLY once (see loadedmetadata)
    let pendingSync = null;        // a sync that arrived before metadata was ready

    function fmt(t) {
      if (!isFinite(t) || t < 0) t = 0;
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = Math.floor(t % 60);
      const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
      const ss = String(s).padStart(2, '0');
      return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }

    // ---------------- protocol: events out ----------------
    function emit(name) {
      post({
        type: 'PLAYER_EVENT',
        data: {
          event: name,
          currentTime: video.currentTime || 0,
          duration: isFinite(video.duration) ? video.duration : 0,
          paused: video.paused,
          source: SOURCE,
          playerId,
        },
      });
    }
    const status = (s) => post({ type: 'VIDORA_PLAYER_STATUS', playerId, status: s });

    // ---------------- overlay (blocked autoplay / errors) ----------------
    function showOverlay(kind, text) {
      player.classList.add('show-overlay');
      player.classList.toggle('overlay-error', kind === 'error');
      overlayLabel.textContent = text || 'Tap to join the party';
      overlayMsg.textContent = kind === 'error' ? (text || '') : '';
      if (kind === 'join') overlayBtn.focus({ preventScroll: true });
    }
    function hideOverlay() { player.classList.remove('show-overlay', 'overlay-error'); }

    // play() the way a party sync needs it: if the browser says no (autoplay
    // policy — nobody has clicked in this tab yet), don't fail silently;
    // put up a button, because a real tap is always allowed to start media.
    function tryPlay() {
      let p;
      try { p = video.play(); } catch (err) { return Promise.resolve(false); }
      if (!p || !p.then) return Promise.resolve(true);
      return p.then(() => { hideOverlay(); return true; }).catch((err) => {
        if (err && err.name === 'NotAllowedError') {
          showOverlay('join', 'Tap to join the party');
          status('blocked');
        }
        return false;
      });
    }

    overlayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideOverlay();
      tryPlay().then((ok) => { if (ok) status('unblocked'); });
    });

    // ---------------- UI helpers ----------------
    function setPlayIcon(playing) {
      playIcon.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      centerIcon.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }

    function togglePlay() {
      if (video.paused || video.ended) tryPlay();
      else video.pause();
    }

    function popCenterIcon() {
      player.classList.add('show-center-btn');
      clearTimeout(popCenterIcon._t);
      popCenterIcon._t = setTimeout(() => player.classList.remove('show-center-btn'), 480);
    }

    function scheduleHide() {
      clearTimeout(hideTimer);
      if (video.paused) return;
      hideTimer = setTimeout(() => {
        if (!isScrubbing && !speedMenu.classList.contains('open')) player.classList.add('controls-hidden');
      }, 2600);
    }

    function wake() {
      player.classList.remove('controls-hidden');
      scheduleHide();
    }

    playBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); wake(); });

    let lastTap = 0;
    clickCatcher.addEventListener('click', (e) => {
      player.focus({ preventScroll: true }); // so the keyboard shortcuts work after a click
      const now = Date.now();
      if (now - lastTap < 320) {
        const rect = player.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (x < rect.width / 2) skip(-10, 'left'); else skip(10, 'right');
      } else {
        togglePlay();
        popCenterIcon();
      }
      lastTap = now;
      wake();
    });

    // ---------------- media element events ----------------
    video.addEventListener('play', () => { setPlayIcon(true); wake(); emit('play'); });
    video.addEventListener('pause', () => {
      setPlayIcon(false);
      clearTimeout(hideTimer);
      player.classList.remove('controls-hidden');
      if (!video.ended) emit('pause');
    });
    video.addEventListener('ended', () => { setPlayIcon(false); emit('ended'); });
    video.addEventListener('seeked', () => emit('seeked'));
    video.addEventListener('waiting', () => player.classList.add('is-buffering'));
    video.addEventListener('playing', () => player.classList.remove('is-buffering'));
    video.addEventListener('canplay', () => player.classList.remove('is-buffering'));
    video.addEventListener('error', () => {
      player.classList.remove('is-buffering');
      showOverlay('error', "This video couldn't be played.");
      status('error');
    });

    function skip(delta, side) {
      const dur = isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(Math.max(0, video.currentTime + delta), dur);
      const el = side === 'left' ? flashLeft : flashRight;
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
      wake();
    }
    backBtn.addEventListener('click', (e) => { e.stopPropagation(); skip(-10, 'left'); });
    fwdBtn.addEventListener('click', (e) => { e.stopPropagation(); skip(10, 'right'); });

    function updateProgress() {
      if (isScrubbing) return;
      const dur = isFinite(video.duration) ? video.duration : 0;
      const pct = dur ? (video.currentTime / dur) * 100 : 0;
      filled.style.width = pct + '%';
      handle.style.left = pct + '%';
      currentTimeEl.textContent = fmt(video.currentTime);
      if (video.buffered.length) {
        const end = video.buffered.end(video.buffered.length - 1);
        buffered.style.width = (dur ? (end / dur) * 100 : 0) + '%';
      }
    }
    video.addEventListener('timeupdate', () => { updateProgress(); emit('timeupdate'); });
    video.addEventListener('progress', updateProgress);

    // The start position (resume point / party join point) is applied ONCE,
    // the first time metadata is available. `loadedmetadata` can fire again
    // — hls.js re-attaches the media element when it recovers from a media
    // error — and re-applying the start time every time is what made
    // playback jump back to the saved spot mid-movie.
    video.addEventListener('loadedmetadata', () => {
      durationEl.textContent = fmt(video.duration);
      if (!startApplied) {
        startApplied = true;
        const st = Number(opts.startTime);
        if (pendingSync) {
          // a party sync that arrived first is newer than any saved start time
          applySync(pendingSync.time, pendingSync.playing, { tolerance: 0 });
          pendingSync = null;
        } else if (isFinite(st) && st > 0) {
          try { video.currentTime = st; } catch (err) { /* not seekable yet */ }
        }
      }
      updateProgress();
    });

    // ---------------- scrubbing ----------------
    // Dragging the bar no longer pauses the video and resumes it afterwards:
    // that produced a pause + play + seeked burst for every drag, which a
    // Watch Party host would broadcast to everyone. Now there's exactly one
    // "seeked" when the drag is released.
    function pctFromEvent(e) {
      const rect = progressWrap.getBoundingClientRect();
      const point = e.touches && e.touches.length ? e.touches[0] : (e.changedTouches && e.changedTouches.length ? e.changedTouches[0] : e);
      return Math.min(1, Math.max(0, (point.clientX - rect.left) / rect.width));
    }

    function scrubMove(e) {
      const pct = pctFromEvent(e);
      filled.style.width = (pct * 100) + '%';
      handle.style.left = (pct * 100) + '%';
      scrubTime = pct * (isFinite(video.duration) ? video.duration : 0);
      scrubTooltip.textContent = fmt(scrubTime);
      scrubTooltip.style.left = (pct * 100) + '%';
      currentTimeEl.textContent = fmt(scrubTime);
      return scrubTime;
    }

    function endScrub(e) {
      if (!isScrubbing) return;
      const t = e ? scrubMove(e) : scrubTime;
      isScrubbing = false;
      progressWrap.classList.remove('scrubbing');
      video.currentTime = t;
      wake();
    }

    progressWrap.addEventListener('mousedown', (e) => {
      isScrubbing = true;
      progressWrap.classList.add('scrubbing');
      scrubMove(e);
      wake();
    });
    listen(window, 'mousemove', (e) => { if (isScrubbing) scrubMove(e); });
    listen(window, 'mouseup', (e) => endScrub(e));
    progressWrap.addEventListener('mousemove', (e) => {
      if (isScrubbing) return;
      const pct = pctFromEvent(e);
      scrubTooltip.textContent = fmt(pct * (isFinite(video.duration) ? video.duration : 0));
      scrubTooltip.style.left = (pct * 100) + '%';
    });
    progressWrap.addEventListener('touchstart', (e) => {
      isScrubbing = true;
      progressWrap.classList.add('scrubbing');
      scrubMove(e);
    }, { passive: true });
    progressWrap.addEventListener('touchmove', (e) => { if (isScrubbing) scrubMove(e); }, { passive: true });
    // touchend used to just clear the flag and resume playing — it never
    // actually seeked, so scrubbing by touch did nothing.
    progressWrap.addEventListener('touchend', () => endScrub(null));
    progressWrap.addEventListener('touchcancel', () => { isScrubbing = false; progressWrap.classList.remove('scrubbing'); });

    // ---------------- volume ----------------
    function updateVolumeUI() {
      const pct = video.muted ? 0 : video.volume * 100;
      volFilled.style.width = pct + '%';
      volHandle.style.left = pct + '%';
      volIcon.innerHTML = (video.muted || video.volume === 0) ? ICON_VOL_MUTE : ICON_VOL_ON;
    }
    muteBtn.addEventListener('click', (e) => { e.stopPropagation(); video.muted = !video.muted; updateVolumeUI(); wake(); });

    let volDragging = false;
    function setVolFromEvent(e) {
      const rect = volTrack.getBoundingClientRect();
      const point = e.touches && e.touches.length ? e.touches[0] : e;
      const pct = Math.min(1, Math.max(0, (point.clientX - rect.left) / rect.width));
      video.volume = pct;
      video.muted = pct === 0;
      updateVolumeUI();
    }
    volTrack.addEventListener('mousedown', (e) => { volDragging = true; setVolFromEvent(e); });
    listen(window, 'mousemove', (e) => { if (volDragging) setVolFromEvent(e); });
    listen(window, 'mouseup', () => { volDragging = false; });
    volumeWrap.addEventListener('click', (e) => e.stopPropagation());

    // ---------------- speed ----------------
    speedBtn.addEventListener('click', (e) => { e.stopPropagation(); speedMenu.classList.toggle('open'); });
    speedMenu.querySelectorAll('.vd-menu-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const speed = parseFloat(item.dataset.speed);
        video.playbackRate = speed;
        speedBtn.textContent = speed + 'x';
        speedMenu.querySelectorAll('.vd-menu-item').forEach((i) => i.classList.remove('active'));
        item.classList.add('active');
        speedMenu.classList.remove('open');
      });
    });
    shadow.addEventListener('click', () => speedMenu.classList.remove('open'));

    // ---------------- fullscreen ----------------
    function toggleFullscreen() {
      if (!document.fullscreenElement) { if (player.requestFullscreen) player.requestFullscreen(); }
      else if (document.exitFullscreen) document.exitFullscreen();
    }
    fsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
    listen(document, 'fullscreenchange', () => {
      fsIcon.innerHTML = document.fullscreenElement ? ICON_FS_EXIT : ICON_FS_ENTER;
    });

    player.addEventListener('mousemove', wake);
    player.addEventListener('mouseleave', () => { if (!video.paused) player.classList.add('controls-hidden'); });
    player.addEventListener('mouseenter', wake);

    player.addEventListener('keydown', (e) => {
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault(); togglePlay(); popCenterIcon(); wake(); break;
        case 'ArrowRight':
          e.preventDefault(); skip(10, 'right'); break;
        case 'ArrowLeft':
          e.preventDefault(); skip(-10, 'left'); break;
        case 'ArrowUp':
          e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); video.muted = false; updateVolumeUI(); wake(); break;
        case 'ArrowDown':
          e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); updateVolumeUI(); wake(); break;
        case 'm':
          video.muted = !video.muted; updateVolumeUI(); wake(); break;
        case 'f':
          toggleFullscreen(); break;
      }
    });

    // ---------------- protocol: commands in ----------------
    function seekTo(t) {
      const n = Number(t);
      if (!isFinite(n)) return;
      const dur = isFinite(video.duration) ? video.duration : Infinity;
      try { video.currentTime = Math.min(Math.max(0, n), Math.max(0, dur - 0.25)); } catch (err) { /* not seekable yet */ }
    }

    // Brings this player to { time, playing }. `tolerance` is how far off
    // (seconds) the position may be before we bother seeking — small
    // corrections are a visible stutter, so they're only made when needed.
    function applySync(time, playing, o) {
      if (video.readyState < 1) {
        // metadata not here yet: remember it, loadedmetadata applies it
        pendingSync = { time, playing };
        if (playing) tryPlay();
        return;
      }
      const tolerance = o && typeof o.tolerance === 'number' ? o.tolerance : 1;
      const t = Number(time);
      if (isFinite(t)) {
        const off = Math.abs(video.currentTime - t);
        // when paused, land precisely so everyone looks at the same frame
        if (off > (playing ? tolerance : Math.min(tolerance, 0.3))) seekTo(t);
      }
      if (playing && video.paused) tryPlay();
      else if (!playing && !video.paused) video.pause();
    }

    function handleCommand(d) {
      switch (d.cmd) {
        case 'play': tryPlay(); break;
        case 'pause': video.pause(); break;
        case 'seek': seekTo(d.time); break;
        case 'sync': applySync(d.time, !!d.playing, { tolerance: d.tolerance }); break;
        case 'ping': post({ type: 'VIDORA_PLAYER_READY', playerId, source: SOURCE, version: PROTOCOL_VERSION }); emit('timeupdate'); break;
        case 'destroy': destroy(); break;
      }
    }

    function onMessage(ev) {
      const d = parseMessage(ev);
      if (!d) return;
      if (!host.isConnected && !destroyed) { destroy(); return; } // page swapped the DOM out from under us
      if (d.type === 'VIDORA_PLAYER_READY') {
        // another player took over this page — step aside so only one exists
        if (d.playerId !== playerId) destroy();
        return;
      }
      if (d.type === 'VIDORA_PLAYER_CMD') handleCommand(d);
    }
    listen(window, 'message', onMessage);

    // ---------------- source ----------------
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(hideTimer);
      cleanups.forEach((fn) => { try { fn(); } catch (err) { /* ignore */ } });
      cleanups.length = 0;
      if (hls) { try { hls.destroy(); } catch (err) { /* ignore */ } hls = null; }
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (err) { /* ignore */ }
      if (host.isConnected) host.remove();
      if (active && active.id === playerId) active = null;
    }

    const src = movie.src || '';
    if (movie.poster) video.poster = movie.poster;
    if (/\.m3u8(\?|$)/i.test(src) && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls();
      hls.on(window.Hls.Events.ERROR, (evt, data) => {
        if (!data || !data.fatal) return;
        // Recover in place. Recovery keeps the current position; nothing
        // here ever re-applies a saved start time.
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { showOverlay('error', "This video couldn't be played."); status('error'); }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else {
      video.src = src;
    }

    video.volume = 1;
    updateVolumeUI();
    setPlayIcon(false);
    player.classList.remove('controls-hidden');
    if (opts.autoplay !== false) tryPlay();

    return {
      id: playerId,
      video,
      play: tryPlay,
      pause: () => video.pause(),
      seek: seekTo,
      sync: applySync,
      destroy,
      announce: () => post({ type: 'VIDORA_PLAYER_READY', playerId, source: SOURCE, version: PROTOCOL_VERSION }),
    };
  }

  // ======================================================================
  // public entry points
  // ======================================================================

  // create({ movie:{src,poster}, container?, startTime?, autoplay? }) -> controller
  async function create(opts) {
    destroyActive();
    const { host, shadow } = buildHost();
    await place(host, opts.container || null);
    const ctl = wireUpPlayer(host, shadow, opts);
    active = ctl;
    ctl.announce(); // also tells any OTHER player on the page (e.g. the site's own copy) to step aside
    return ctl;
  }

  // Extension entry: the popup hands us { src, title? }.
  async function inject(movie, opts) {
    return create({ movie, startTime: opts && opts.startTime, autoplay: true });
  }

  window.VidoraNativePlayer = { create, inject, version: PROTOCOL_VERSION };

  if (IS_EXTENSION) {
    // Re-injecting this file (every click on a quality button does) must not
    // stack another message listener — that created a second player per
    // injection. Keep one listener and point it at the newest code.
    window.__vidoraNativeInject = inject;
    if (!window.__vidoraNativeListener) {
      window.__vidoraNativeListener = true;
      chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if ((message.action === 'INJECT_VIDORA_PLAYER' || message.action === 'INJECT_STREAM') && (message.movie || message.streamUrl)) {
          const movieData = message.movie || { src: message.streamUrl };
          window.__vidoraNativeInject(movieData)
            .then(() => sendResponse({ status: 'success' }))
            .catch((err) => sendResponse({ status: 'error', error: String(err && err.message || err) }));
          return true; // keep the message channel open for the async response
        }
        return false;
      });
    }
  }
})();
