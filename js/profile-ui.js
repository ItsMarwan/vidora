/**
 * VIDORA — PROFILE PAGE UI
 * Renders the /profile page: a first-run "set up your profile" form when
 * none exists yet, or the full profile card (edit, delete) plus the
 * export/import tools once one does. Relies on globals defined in app.js
 * (backBar, wireBackButtons, escAttr) — safe because this only runs from
 * user interaction after the whole page has loaded, regardless of the
 * <script> order these files are included in.
 */

const ProfileUI = (() => {
  const FIELD_LABELS = {
    profile: "Profile (name & photo)",
    myList: "My List",
    continueWatching: "Continue Watching",
  };

  function renderPage(container) {
    if (!VidoraProfile.hasProfile()) renderCreateForm(container);
    else renderManageView(container);
  }

  // ---------------- first-run: create profile ----------------
  function renderCreateForm(container) {
    container.innerHTML = `
      <div class="wrap">
        <div class="grid-page-head">
          ${backBar("Back", "/")}
          <h1 class="grid-page-title">Set up your profile</h1>
          <p class="grid-page-desc">A local profile lives only in this browser — a name and photo so Watch Party guests recognize you, plus one place to export or import everything Vidora has saved for you.</p>
        </div>
        <div class="profile-card profile-setup">
          <label for="profileNameInput">Display name</label>
          <input type="text" id="profileNameInput" maxlength="24" placeholder="Your name" autocomplete="off" />
          <div class="profile-avatar-picker">
            <div class="profile-avatar-preview" id="profileAvatarPreview">${VD.icon("user", { size: 30 })}</div>
            <div>
              <label class="btn btn-ghost profile-photo-btn" for="profileImageInput">${VD.icon("upload", { size: 15 })} Choose photo</label>
              <input type="file" id="profileImageInput" accept="image/*" hidden />
              <p class="profile-photo-hint">Optional — square photos work best.</p>
            </div>
          </div>
          <button class="btn btn-primary" id="profileCreateBtn" disabled>Create profile</button>
        </div>
      </div>`;
    wireBackButtons(container);

    let pendingImage = null;
    const preview = container.querySelector("#profileAvatarPreview");
    const nameInput = container.querySelector("#profileNameInput");
    const createBtn = container.querySelector("#profileCreateBtn");

    nameInput.addEventListener("input", () => { createBtn.disabled = !nameInput.value.trim(); });
    nameInput.focus();

    container.querySelector("#profileImageInput").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        pendingImage = await VidoraProfile.fileToAvatar(file);
        preview.innerHTML = `<img src="${pendingImage}" alt="" />`;
      } catch (err) {
        VD.toast(err.message || "Couldn't use that photo.");
      }
    });

    createBtn.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) return;
      VidoraProfile.createProfile({ name, image: pendingImage });
      VD.toast("Profile created.");
      renderPage(container);
    });
  }

  // ---------------- profile exists: manage view ----------------
  function renderManageView(container) {
    const profile = VidoraProfile.getProfile();
    const created = profile.createdAt
      ? new Date(profile.createdAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
      : "";
    const exportFields = VidoraProfile.availableExportFields();

    container.innerHTML = `
      <div class="wrap">
        <div class="grid-page-head">
          ${backBar("Back", "/")}
          <h1 class="grid-page-title">Profile</h1>
          <p class="grid-page-desc">Your local profile and saved data, all stored only in this browser.</p>
        </div>

        <div class="profile-card">
          <div class="profile-header">
            <div class="profile-avatar-lg">${profile.image ? `<img src="${escAttr(profile.image)}" alt="" />` : VD.icon("user", { size: 30 })}</div>
            <div class="profile-header-text">
              <h2>${escAttr(profile.name)}</h2>
              ${created ? `<p class="profile-since">Profile created ${created}</p>` : ""}
            </div>
          </div>
          <div class="profile-actions">
            <button class="btn btn-ghost" id="profileEditBtn">${VD.icon("edit", { size: 15 })} Edit profile</button>
            <button class="btn btn-danger" id="profileDeleteBtn">${VD.icon("trash", { size: 15 })} Delete profile</button>
          </div>
        </div>

        <div class="profile-section">
          <h3>Export your data</h3>
          <p class="profile-section-desc">Choose what to include — you'll get one .json file you can keep or import into Vidora on another browser or device.</p>
          <div class="profile-checklist" id="exportChecklist">
            ${exportFields.map((f) => `
              <label class="profile-check-row${f.present ? "" : " disabled"}">
                <input type="checkbox" value="${f.key}" ${f.present ? "checked" : "disabled"} />
                <span>${f.label}</span>
                ${f.present ? "" : `<span class="profile-check-empty">Nothing saved yet</span>`}
              </label>`).join("")}
          </div>
          <button class="btn btn-primary" id="profileExportBtn">${VD.icon("download", { size: 15 })} Export selected</button>
        </div>

        <div class="profile-section">
          <h3>Import data</h3>
          <p class="profile-section-desc">Pick a Vidora export file, then choose what to bring in. Imported data is merged with — not replacing — what's already here.</p>
          <input type="file" id="profileImportInput" accept="application/json" class="profile-file-input" />
          <div id="importChecklistWrap"></div>
        </div>
      </div>`;

    wireBackButtons(container);
    wireManageActions(container);
  }

  function wireManageActions(container) {
    const editBtn = container.querySelector("#profileEditBtn");
    const deleteBtn = container.querySelector("#profileDeleteBtn");
    const exportBtn = container.querySelector("#profileExportBtn");
    const importInput = container.querySelector("#profileImportInput");
    const importWrap = container.querySelector("#importChecklistWrap");

    if (editBtn) editBtn.addEventListener("click", () => openEditModal(container));

    if (deleteBtn) deleteBtn.addEventListener("click", () => {
      VD.modal({
        title: "Delete your profile?",
        sub: "This removes your name and photo from this browser. My List and Continue Watching are not affected.",
        actions: [
          { id: "cancel", label: "Keep profile", variant: "btn-ghost", onClick: (close) => close() },
          { id: "delete", label: "Delete profile", variant: "btn-danger", onClick: (close) => {
              VidoraProfile.deleteProfile();
              close();
              VD.toast("Profile deleted.");
              renderPage(container);
            } },
        ],
      });
    });

    if (exportBtn) exportBtn.addEventListener("click", () => {
      const keys = [...container.querySelectorAll('#exportChecklist input[type="checkbox"]:checked')].map((c) => c.value);
      if (!keys.length) { VD.toast("Choose at least one thing to export."); return; }
      VidoraProfile.downloadExport(keys);
      VD.toast("Export downloaded.");
    });

    if (importInput) importInput.addEventListener("change", async () => {
      const file = importInput.files[0];
      if (!file) return;
      importWrap.innerHTML = "";
      try {
        const parsed = await VidoraProfile.readImportFile(file);
        const keys = Object.keys(parsed.data || {}).filter((k) => FIELD_LABELS[k]);
        if (!keys.length) {
          importWrap.innerHTML = `<p class="profile-section-desc">That file doesn't contain anything Vidora recognizes.</p>`;
          return;
        }
        importWrap.innerHTML = `
          <div class="profile-checklist">
            ${keys.map((k) => `
              <label class="profile-check-row">
                <input type="checkbox" value="${k}" checked />
                <span>${FIELD_LABELS[k]}</span>
              </label>`).join("")}
          </div>
          <button class="btn btn-primary" id="profileImportBtn">${VD.icon("upload", { size: 15 })} Import selected</button>`;
        importWrap.querySelector("#profileImportBtn").addEventListener("click", () => {
          const selected = [...importWrap.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
          if (!selected.length) { VD.toast("Choose at least one thing to import."); return; }
          VidoraProfile.importSelected(parsed, selected);
          VD.toast("Import complete.");
          renderPage(container);
        });
      } catch (err) {
        importWrap.innerHTML = `<p class="profile-section-desc">${escAttr(err.message || "Couldn't read that file.")}</p>`;
      }
    });
  }

  function openEditModal(container) {
    const profile = VidoraProfile.getProfile();
    let pendingImage = profile.image || null;

    const handle = VD.modal({
      title: "Edit profile",
      bodyHTML: `
        <label for="editNameInput">Display name</label>
        <input type="text" id="editNameInput" maxlength="24" value="${escAttr(profile.name)}" autocomplete="off" />
        <div class="profile-avatar-picker">
          <div class="profile-avatar-preview" id="editAvatarPreview">${profile.image ? `<img src="${escAttr(profile.image)}" alt="" />` : VD.icon("user", { size: 30 })}</div>
          <div>
            <label class="btn btn-ghost profile-photo-btn" for="editImageInput">${VD.icon("upload", { size: 15 })} Change photo</label>
            <input type="file" id="editImageInput" accept="image/*" hidden />
            ${profile.image ? `<button type="button" class="btn btn-ghost profile-photo-remove" id="editImageRemove">Remove photo</button>` : ""}
          </div>
        </div>
      `,
      actions: [
        { id: "cancel", label: "Cancel", variant: "btn-ghost", onClick: (close) => close() },
        { id: "save", label: "Save", variant: "btn-primary", onClick: (close) => {
            const name = document.getElementById("editNameInput").value.trim();
            if (!name) { VD.toast("Give yourself a name first."); return; }
            VidoraProfile.updateProfile({ name, image: pendingImage });
            close();
            VD.toast("Profile updated.");
            renderPage(container);
          } },
      ],
    });

    const preview = handle.el.querySelector("#editAvatarPreview");
    handle.el.querySelector("#editImageInput").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        pendingImage = await VidoraProfile.fileToAvatar(file);
        preview.innerHTML = `<img src="${pendingImage}" alt="" />`;
      } catch (err) {
        VD.toast(err.message || "Couldn't use that photo.");
      }
    });
    const removeBtn = handle.el.querySelector("#editImageRemove");
    if (removeBtn) removeBtn.addEventListener("click", () => {
      pendingImage = null;
      preview.innerHTML = VD.icon("user", { size: 30 });
    });
  }

  return { renderPage };
})();
