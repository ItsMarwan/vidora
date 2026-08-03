/**
 * VIDORA — UI COMPONENTS
 * Small, dependency-free replacements for native <select>, window.alert,
 * and ad-hoc notifications, styled to match the rest of the app.
 */

const VD = (() => {
  let seq = 0;

  // ---------------- Icon library ----------------
  // Small hand-built set of stroke-based line icons (24x24, currentColor)
  // in the Feather/Lucide style — no emoji anywhere, no CDN dependency, so
  // icons render identically and instantly regardless of network state.
  const ICONS = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V10"/>',
    film: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h4M3 15h4M17 9h4M17 15h4M9.5 4.5v15M14.5 4.5v15"/>',
    tv: '<rect x="3" y="6.5" width="18" height="13" rx="2"/><path d="M8 3.5 12 6.5 16 3.5"/>',
    heart: '<path d="M12 20.5s-7.5-4.6-10-9.4C.4 7.6 2.4 4 6 4c2.1 0 3.6 1.1 6 3.4C14.4 5.1 15.9 4 18 4c3.6 0 5.6 3.6 4 7.1-2.5 4.8-10 9.4-10 9.4Z"/>',
    heartFilled: '<path d="M12 20.5s-7.5-4.6-10-9.4C.4 7.6 2.4 4 6 4c2.1 0 3.6 1.1 6 3.4C14.4 5.1 15.9 4 18 4c3.6 0 5.6 3.6 4 7.1-2.5 4.8-10 9.4-10 9.4Z" fill="currentColor" stroke="none"/>',
    dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.2" cy="8.2" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.8" cy="8.2" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="8.2" cy="15.8" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.8" cy="15.8" r="1.3" fill="currentColor" stroke="none"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    star: '<path d="m12 3.5 2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6Z"/>',
    starFilled: '<path d="m12 3.5 2.6 5.6 6.1.6-4.6 4.1 1.3 6-5.4-3.1-5.4 3.1 1.3-6-4.6-4.1 6.1-.6Z" fill="currentColor" stroke="none"/>',
    play: '<path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l11.5-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8Z"/>',
    playFilled: '<path d="M7 4.8v14.4a1 1 0 0 0 1.5.86l11.5-7.2a1 1 0 0 0 0-1.72L8.5 3.94A1 1 0 0 0 7 4.8Z" fill="currentColor" stroke="none"/>',
    users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M2.8 19.5c.7-3.2 3.3-5 6.2-5s5.5 1.8 6.2 5"/><path d="M15.8 5.7a3.2 3.2 0 0 1 0 6.2"/><path d="M17.6 14.7c2.5.5 4.3 2.2 4.9 4.8"/>',
    save: '<path d="M5 3.5h11.2L20 7.3V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19V5A1.5 1.5 0 0 1 5 3.5Z"/><path d="M7.5 3.5V9h7V3.5M7.5 20.2v-6h9v6"/>',
    maximize: '<path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5"/>',
    skipForward: '<path d="M5.5 5v14l10-7-10-7Z"/><path d="M18 5v14"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    crown: '<path d="M3.5 17.5h17l1-9-5.5 4-3.5-6.5-3.5 6.5-5.5-4Z"/><path d="M4 20.5h16"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M5.5 15.5h-1a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    share: '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.6 7.4-4.2M8.3 13.4l7.4 4.2"/>',
    clapper: '<path d="M3.5 10.5 5 4.8l2.6.7-1.5 3.5M8.6 11.4l1.7-5.6 2.6.7-1.6 5.4M13.8 11.7l1.4-5.4 2.7.6-1.4 5.4"/><rect x="3.5" y="10.5" width="17" height="9.2" rx="1.5"/>',
    sparkle: '<path d="M12 3.5c.5 3 1.9 4.4 4.9 4.9-3 .5-4.4 1.9-4.9 4.9-.5-3-1.9-4.4-4.9-4.9 3-.5 4.4-1.9 4.9-4.9Z"/><path d="M19 14.5c.3 1.6 1 2.3 2.6 2.6-1.6.3-2.3 1-2.6 2.6-.3-1.6-1-2.3-2.6-2.6 1.6-.3 2.3-1 2.6-2.6Z"/>',
    checkCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>',
  };

  function icon(name, { size = 20, cls = "" } = {}) {
    const body = ICONS[name] || ICONS.sparkle;
    return `<svg class="vd-icon${cls ? " " + cls : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  // Fills every [data-icon="name"] element in `root` with the matching SVG.
  // Used for the icon placeholders baked into index.html's static markup
  // (available immediately since components.js runs before app.js, and
  // both run after the DOM has already parsed). Dynamically-built markup
  // elsewhere just calls icon() directly inline instead of round-tripping
  // through data attributes.
  function hydrateIcons(root = document) {
    root.querySelectorAll("[data-icon]").forEach((el) => {
      el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 20 });
    });
  }

  // ---------------- Dropdown (replaces <select>) ----------------
  function dropdown({ mount, options, selected, onChange, ariaLabel }) {
    const id = `vd-dd-${seq++}`;
    const panelId = `${id}-panel`;
    const wrap = document.createElement("div");
    wrap.className = "vd-dropdown";
    wrap.id = id;
    const current = options.find((o) => String(o.value) === String(selected)) || options[0];

    wrap.innerHTML = `
      <button type="button" class="vd-dropdown-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${panelId}" ${ariaLabel ? `aria-label="${ariaLabel}"` : ""}>
        <span class="vd-dropdown-label">${current ? current.label : "Select"}</span>
        <span class="chevron" aria-hidden="true">${icon("chevronDown", { size: 15 })}</span>
      </button>
      <div class="vd-dropdown-panel" id="${panelId}" role="listbox" aria-hidden="true">
        ${options.map((o) => `<div class="vd-dropdown-option ${String(o.value) === String(current?.value) ? "selected" : ""}" data-value="${o.value}" role="option" aria-selected="${String(o.value) === String(current?.value)}" tabindex="-1">${o.label}</div>`).join("")}
      </div>`;

    mount.innerHTML = "";
    mount.appendChild(wrap);

    const trigger = wrap.querySelector(".vd-dropdown-trigger");
    const panel = wrap.querySelector(".vd-dropdown-panel");
    const labelEl = wrap.querySelector(".vd-dropdown-label");

    function closeAll() {
      document.querySelectorAll(".vd-dropdown.open").forEach((d) => {
        d.classList.remove("open");
        const t = d.querySelector(".vd-dropdown-trigger");
        const p = d.querySelector(".vd-dropdown-panel");
        if (t) t.setAttribute("aria-expanded", "false");
        if (p) p.setAttribute("aria-hidden", "true");
      });
    }
    function close() {
      wrap.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      panel.setAttribute("aria-hidden", "true");
    }
    function open() {
      closeAll();
      wrap.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      panel.setAttribute("aria-hidden", "false");
    }

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      wrap.classList.contains("open") ? close() : open();
    });
    panel.addEventListener("click", (e) => {
      const opt = e.target.closest(".vd-dropdown-option");
      if (!opt) return;
      panel.querySelectorAll(".vd-dropdown-option").forEach((o) => o.classList.remove("selected"));
      opt.classList.add("selected");
      panel.querySelectorAll(".vd-dropdown-option").forEach((o) => o.setAttribute("aria-selected", o === opt ? "true" : "false"));
      labelEl.textContent = opt.textContent;
      close();
      if (onChange) onChange(opt.dataset.value);
      trigger.focus();
    });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(); });
    wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { close(); trigger.focus(); }
    });

    return {
      setSelected(value) {
        const opt = [...panel.querySelectorAll(".vd-dropdown-option")].find((o) => o.dataset.value === String(value));
        if (!opt) return;
        panel.querySelectorAll(".vd-dropdown-option").forEach((o) => { o.classList.remove("selected"); o.setAttribute("aria-selected", "false"); });
        opt.classList.add("selected");
        opt.setAttribute("aria-selected", "true");
        labelEl.textContent = opt.textContent;
      },
    };
  }

  // ---------------- Modal ----------------
  function modal({ title, sub, bodyHTML, actions = [], wide = false }) {
    const titleId = `vd-modal-title-${seq++}`;
    const triggerEl = document.activeElement;
    const backdrop = document.createElement("div");
    backdrop.className = "vd-modal-backdrop";
    backdrop.innerHTML = `
      <div class="vd-modal${wide ? " vd-modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
        <button class="vd-modal-close" aria-label="Close">${icon("close", { size: 18 })}</button>
        <h3 id="${titleId}">${title}</h3>
        ${sub ? `<p class="sub">${sub}</p>` : ""}
        <div class="vd-modal-body">${bodyHTML || ""}</div>
        <div class="vd-modal-actions">
          ${actions.map((a) => `<button class="btn ${a.variant || "btn-ghost"}" data-action="${a.id}">${a.label}</button>`).join("")}
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const dialog = backdrop.querySelector(".vd-modal");
    function focusable() {
      return [...dialog.querySelectorAll('button, input, select, textarea, a[href]')].filter((el) => !el.disabled && el.offsetParent !== null);
    }
    const firstField = dialog.querySelector("input, select, textarea");
    (firstField || dialog.querySelector(".vd-modal-close")).focus();

    function close() {
      backdrop.remove();
      document.removeEventListener("keydown", onKeydown);
      if (triggerEl && triggerEl.focus) triggerEl.focus();
    }
    function onKeydown(e) {
      if (e.key === "Escape") { close(); return; }
      if (e.key === "Tab") {
        const items = focusable();
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKeydown);
    backdrop.querySelector(".vd-modal-close").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    actions.forEach((a) => {
      const btn = backdrop.querySelector(`[data-action="${a.id}"]`);
      if (btn) btn.addEventListener("click", () => a.onClick(close, backdrop));
    });
    return { close, el: backdrop };
  }

  // ---------------- Toast ----------------
  function toast(message) {
    let stack = document.querySelector(".vd-toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "vd-toast-stack";
      stack.setAttribute("role", "status");
      stack.setAttribute("aria-live", "polite");
      document.body.appendChild(stack);
    }
    const t = document.createElement("div");
    t.className = "vd-toast";
    t.textContent = message;
    stack.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  return { dropdown, modal, toast, icon, hydrateIcons };
})();

VD.hydrateIcons();