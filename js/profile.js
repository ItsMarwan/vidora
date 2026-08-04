/**
 * VIDORA — LOCAL PROFILE
 * -----------------------------------------------------------
 * A "local account": just a name + optional photo, stored in this
 * browser's localStorage. There's no server-side account system — this
 * module is the single source of truth for:
 *   - creating / editing / deleting the local profile
 *   - resizing an uploaded photo down to a small square avatar so it's
 *     cheap to store locally AND cheap to relay through Watch Party
 *   - exporting everything Vidora knows about this browser (profile, My
 *     List, Continue Watching) as one downloadable .json file
 *   - importing a previously-exported file back in, field by field
 * Nothing here ever talks to a server on its own. The only place profile
 * data leaves the browser is Watch Party (name + avatar, sent so guests
 * can see who's hosting) and the export file the person explicitly saves.
 * -----------------------------------------------------------
 */

const VidoraProfile = (() => {
  const PROFILE_KEY = "vidora_profile";
  const MY_LIST_KEY = "vidora_my_list";
  const CONTINUE_KEY = "vidora_continue_watching";
  let inMemoryProfile = null;

  function readStorage(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  function writeStorage(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (err) { return false; }
  }

  // ---------------- change listeners ----------------
  // Lets the navbar avatar, Watch Party UI, etc. react immediately when the
  // profile is created, edited, or deleted, instead of only refreshing on
  // the next navigation.
  const listeners = [];
  function onChange(cb) {
    listeners.push(cb);
    return () => { const i = listeners.indexOf(cb); if (i > -1) listeners.splice(i, 1); };
  }
  function emitChange() {
    const profile = getProfile();
    listeners.forEach((cb) => { try { cb(profile); } catch (err) { console.error("[Profile] listener error:", err); } });
  }

  // ---------------- read / write ----------------
  function getProfile() {
    const raw = readStorage(PROFILE_KEY);
    if (!raw) return inMemoryProfile;
    try { return JSON.parse(raw); } catch (err) {
      try { localStorage.removeItem(PROFILE_KEY); } catch (ignore) {}
      return inMemoryProfile;
    }
  }
  function hasProfile() { return !!getProfile(); }

  function saveProfile(profile) {
    const json = JSON.stringify(profile);
    if (!writeStorage(PROFILE_KEY, json)) {
      console.warn("[Profile] localStorage write failed; preserving profile in memory for this session.");
    }
    inMemoryProfile = profile;
    emitChange();
    return profile;
  }

  function createProfile({ name, image }) {
    const existing = getProfile();
    const profile = {
      id: (existing && existing.id) || `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: String(name || "You").trim().slice(0, 24) || "You",
      image: image || null,
      createdAt: (existing && existing.createdAt) || Date.now(),
      updatedAt: Date.now(),
    };
    return saveProfile(profile);
  }

  function updateProfile(patch = {}) {
    const current = getProfile();
    if (!current) return createProfile(patch);
    const next = { ...current, updatedAt: Date.now() };
    if ("name" in patch) next.name = String(patch.name || "You").trim().slice(0, 24) || "You";
    if ("image" in patch) next.image = patch.image || null;
    return saveProfile(next);
  }

  function deleteProfile() {
    try { localStorage.removeItem(PROFILE_KEY); } catch (err) {}
    inMemoryProfile = null;
    emitChange();
  }

  // ---------------- avatar image handling ----------------
  // Crops to a centered square and re-encodes at a small fixed size so a
  // multi-megabyte phone photo becomes a few KB — small enough to sit
  // comfortably in localStorage and to relay through Watch Party's KV
  // store without ever touching the original file.
  function fileToAvatar(file, size = 160) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith("image/")) {
        reject(new Error("Choose an image file."));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Couldn't read that image."));
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#1d1c22";
          ctx.fillRect(0, 0, size, size);
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2;
          const sy = (img.height - side) / 2;
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------------- export ----------------
  const EXPORT_FIELDS = {
    profile: {
      label: "Profile (name & photo)",
      read: () => getProfile(),
      present: () => hasProfile(),
    },
    myList: {
      label: "My List",
      read: () => { try { return JSON.parse(localStorage.getItem(MY_LIST_KEY)) || {}; } catch { return {}; } },
      present: () => Object.keys(EXPORT_FIELDS.myList.read()).length > 0,
    },
    continueWatching: {
      label: "Continue Watching",
      read: () => { try { return JSON.parse(localStorage.getItem(CONTINUE_KEY)) || {}; } catch { return {}; } },
      present: () => Object.keys(EXPORT_FIELDS.continueWatching.read()).length > 0,
    },
  };

  // What the profile page's export checklist renders — one row per field,
  // with whether there's actually anything saved for it right now.
  function availableExportFields() {
    return Object.entries(EXPORT_FIELDS).map(([key, def]) => ({
      key, label: def.label, present: def.present(),
    }));
  }

  function buildExport(selectedKeys) {
    const payload = { app: "vidora", exportVersion: 1, exportedAt: new Date().toISOString(), data: {} };
    selectedKeys.forEach((key) => {
      if (EXPORT_FIELDS[key]) payload.data[key] = EXPORT_FIELDS[key].read();
    });
    return payload;
  }

  function downloadExport(selectedKeys) {
    const payload = buildExport(selectedKeys);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vidora-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a moment to actually start the download before the
    // backing blob URL is revoked out from under it.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------- import ----------------
  function readImportFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) { reject(new Error("Choose a file first.")); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.onload = () => {
        let parsed;
        try { parsed = JSON.parse(reader.result); }
        catch { reject(new Error("That doesn't look like a valid Vidora export file.")); return; }
        if (!parsed || parsed.app !== "vidora" || !parsed.data || typeof parsed.data !== "object") {
          reject(new Error("That doesn't look like a valid Vidora export file."));
          return;
        }
        resolve(parsed);
      };
      reader.readAsText(file);
    });
  }

  // Merges rather than replaces: My List and Continue Watching are keyed
  // objects, so imported entries are laid on top of what's already saved
  // instead of wiping it out.
  function importSelected(parsed, selectedKeys) {
    const imported = [];
    selectedKeys.forEach((key) => {
      if (!parsed.data || !(key in parsed.data)) return;
      const value = parsed.data[key];
      if (key === "profile" && value) {
        saveProfile({ ...value, updatedAt: Date.now() });
        imported.push(key);
      } else if (key === "myList" && value && typeof value === "object") {
        const existing = EXPORT_FIELDS.myList.read();
        localStorage.setItem(MY_LIST_KEY, JSON.stringify({ ...existing, ...value }));
        imported.push(key);
      } else if (key === "continueWatching" && value && typeof value === "object") {
        const existing = EXPORT_FIELDS.continueWatching.read();
        localStorage.setItem(CONTINUE_KEY, JSON.stringify({ ...existing, ...value }));
        imported.push(key);
      }
    });
    emitChange();
    return imported;
  }

  return {
    getProfile, hasProfile, createProfile, updateProfile, deleteProfile,
    fileToAvatar,
    availableExportFields, downloadExport, readImportFile, importSelected,
    onChange,
  };
})();
