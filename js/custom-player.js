(function () {
  // Lightweight in-page version of the extension's player UI.
  // Exposes `window.injectCustomPlayer(movie, opts)` where movie = { src, poster }

  const styleCss = `/* truncated for brevity — reusing extension styles */`;

  // Minimal markup (reuse from extension but simplified)
  const markup = `
    <div class="vd-player" id="vdPlayer" tabindex="0">
      <video id="vdVideo" playsinline preload="metadata"></video>
      <div class="vd-click-catcher" id="vdClickCatcher"></div>
      <div class="vd-center-btn" id="vdCenterBtn"><svg id="vdCenterIcon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>
      <div class="vd-spinner" id="vdSpinner"></div>
      <div class="vd-controls" id="vdControls">
        <div class="vd-progress-wrap" id="vdProgressWrap">
          <div class="vd-progress-track"><div class="vd-progress-buffered" id="vdBuffered"></div><div class="vd-progress-filled" id="vdFilled"></div><div class="vd-progress-handle" id="vdHandle"></div></div>
          <div class="vd-scrub-tooltip" id="vdScrubTooltip">0:00</div>
        </div>
        <div class="vd-row">
          <button class="vd-btn" id="vdPlayBtn" aria-label="Play"><svg id="vdPlayIcon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></button>
          <div class="vd-time"><span id="vdCurrentTime">0:00</span> / <span id="vdDuration">0:00</span></div>
          <div class="vd-spacer"></div>
          <button class="vd-btn" id="vdFullscreenBtn" aria-label="Fullscreen"><svg id="vdFsIcon" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg></button>
        </div>
      </div>
    </div>`;

  function buildHost() {
    const host = document.createElement('div');
    host.id = 'vidora-custom-player-host';
    host.style.width = '100%'; host.style.height = '100%'; host.style.display = 'block';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = styleCss;
    shadow.appendChild(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = markup;
    shadow.appendChild(wrap.firstElementChild);
    return { host, shadow };
  }

  async function wireUpPlayer(shadow, movie, opts = {}) {
    const player = shadow.getElementById('vdPlayer');
    const video = shadow.getElementById('vdVideo');
    const playBtn = shadow.getElementById('vdPlayBtn');
    const playIcon = shadow.getElementById('vdPlayIcon');
    const currentTimeEl = shadow.getElementById('vdCurrentTime');
    const durationEl = shadow.getElementById('vdDuration');
    const filled = shadow.getElementById('vdFilled');
    const handle = shadow.getElementById('vdHandle');
    const buffered = shadow.getElementById('vdBuffered');

    function fmt(t) {
      if (!isFinite(t) || t < 0) t = 0;
      const h = Math.floor(t/3600); const m = Math.floor((t%3600)/60); const s = Math.floor(t%60);
      const mm = h>0?String(m).padStart(2,'0'):String(m);
      const ss = String(s).padStart(2,'0');
      return h>0?`${h}:${mm}:${ss}`:`${mm}:${ss}`;
    }

    function emitEvent(name) {
      const payload = { event: name, currentTime: video.currentTime || 0, duration: video.duration || 0 };
      try { window.postMessage(JSON.stringify({ type: 'PLAYER_EVENT', data: payload }), '*'); } catch {}
    }

    function setPlayIcon(playing) { playIcon.innerHTML = playing ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>'; }

    playBtn.addEventListener('click', (e) => { e.stopPropagation(); if (video.paused || video.ended) video.play(); else video.pause(); });

    video.addEventListener('play', () => { setPlayIcon(true); emitEvent('play'); });
    video.addEventListener('pause', () => { setPlayIcon(false); emitEvent('pause'); });
    video.addEventListener('ended', () => { emitEvent('ended'); });
    video.addEventListener('timeupdate', () => { const dur = video.duration||0; const pct = dur? (video.currentTime/dur)*100:0; filled.style.width = pct+'%'; handle.style.left = pct+'%'; currentTimeEl.textContent = fmt(video.currentTime); if (video.buffered.length) { const end = video.buffered.end(video.buffered.length-1); buffered.style.width = (dur?(end/dur)*100:0)+'%'; } emitEvent('timeupdate'); });
    video.addEventListener('seeked', () => emitEvent('seeked'));

    const src = movie.src;
    const requestHeaders = movie.headers || {};
    if (src && src.includes('.m3u8')) {
      if (window.Hls && Hls.isSupported()) {
        const hls = new Hls({
          xhrSetup: (xhr, url) => {
            Object.entries(requestHeaders).forEach(([key, value]) => {
              if (!value || value === 'undefined') return;
              try { xhr.setRequestHeader(key, String(value)); } catch (err) {}
            });
            if (requestHeaders.referer) {
              try { xhr.setRequestHeader('Referer', String(requestHeaders.referer)); } catch (err) {}
            }
            if (requestHeaders.origin) {
              try { xhr.setRequestHeader('Origin', String(requestHeaders.origin)); } catch (err) {}
            }
          }
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      } else {
        video.src = src; // may work on Safari
      }
    } else {
      video.src = src || '';
    }
    if (movie.poster) video.poster = movie.poster;

    // start time / autoplay options
    video.addEventListener('loadedmetadata', () => {
      durationEl.textContent = fmt(video.duration);
      if (opts.startTime && isFinite(opts.startTime) && opts.startTime > 0) {
        try { video.currentTime = opts.startTime; } catch {}
      }
      if (opts.autoplay) video.play().catch(() => {});
    });

    video.volume = 1;
    setPlayIcon(false);
  }

  async function injectPlayer(movie, opts = {}) {
    const { host, shadow } = buildHost();
    const iframe = document.querySelector('.player-frame-wrap iframe');
    if (iframe) {
      if (iframe.id) host.dataset.replacedId = iframe.id;
      if (iframe.className) host.className = iframe.className;
      iframe.replaceWith(host);
    } else {
      const fallback = document.getElementById('player') || document.querySelector('.player-wrapper, .player-container, main') || document.body;
      fallback.appendChild(host);
    }
    await wireUpPlayer(shadow, movie, opts);
  }

  // Expose globally
  window.injectCustomPlayer = injectPlayer;
})();
