/* =========================================================================
   app.js — Contrôleur : état, appels API, câblage de l'interface.
   Flux : dépôt du fichier → profilage/rôles → graphe maître → carte vivante.
   Tout réglage modifie une projection ; seuls les changements structurels
   relancent la disposition (les positions restent stables sinon).
   ========================================================================= */
(function () {
  "use strict";

  // ------------------------------------------------------------------ état
  const State = {
    sessionId: null, filename: null,
    profile: null, summary: null,
    layersOn: new Set(),
    pivot: null,                 // type d'entité (colonne) ou null
    linkMode: "report",
    pivotMode: "reorganize",
    colorBy: "type",
    sizeBy: "degree",
    labels: "pivots",
    displayMode: "auto",
    layout: "force",
    showHinge: false,
    yearMin: null, yearMax: null,
    fullYearMin: null, fullYearMax: null,
    timeMode: "cumulative",       // cumulative | window
    windowWidth: 5,
    playing: false, playSpeed: 550,
    tlCounts: [], tlMax: 1,
    search: "",
    selected: null,
    lastGraph: null,
    layoutSig: null,
    // Dernière configuration appliquée → restaurée si on rouvre l'écran des rôles.
    appliedRoles: null,
    appliedUnit: null,
    appliedHingeKey: "",
    cardFields: [],               // champs actuellement montrés sur la carte d'un livre
    cardFieldsSel: null,          // sélection mémorisée (null = défaut adaptatif)
    cardsLoaded: false,           // /cards déjà chargé pour le graphe courant ?
  };

  const $ = (id) => document.getElementById(id);
  const el = {};
  ["upload-screen", "dropzone", "file-input", "demo-btn", "upload-err",
   "roles-overlay", "roles-body", "roles-hint", "roles-build", "roles-cancel", "roles-status",
   "unit-singular", "unit-preview", "hinge-key",
   "app", "brand-sub", "search", "pivot-list", "layers-list", "hinge-layer", "hinge-label", "reconfig",
   "adv", "adv-toggle", "seg-link", "seg-pivot", "seg-color", "seg-labels",
   "card-fields", "card-fields-ctrl", "card-fields-note",
   "size-by", "layout-sel", "display-mode", "rail-foot",
   "yr-min", "yr-max", "yr-lo", "yr-hi", "yr-reset", "timewrap",
   "tl", "tl-hist", "tl-window", "tl-play", "tl-speed",
   "seg-timemode", "ctrl-window", "window-width", "window-width-val",
   "export-btn", "share-btn", "detail", "dhead", "d-title", "d-sub", "dbody", "dclose",
   "statusline", "epoch-legend", "el-min", "el-max", "el-bar", "time-axis",
   "export-overlay", "exp-scope", "exp-hops", "exp-format", "exp-dim", "exp-labels",
   "exp-image", "exp-close", "exp-status",
   "snapshots-btn", "snapshots-overlay", "snap-close", "snap-interval",
   "snap-cumulative", "snap-status", "snap-grid",
   "chrono-btn", "chrono-overlay", "chrono-close", "chrono-title", "chrono-sub",
   "chrono-pivot", "chrono-color", "chrono-status", "chrono-scroll"
  ].forEach((id) => { el[id] = $(id); });

  // Nom de la charnière (« objet / objets » par défaut). cap() capitalise pour
  // les titres ; les comptes inline restent en minuscules.
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const unitS = () => (State.summary && State.summary.unit_singular) || "objet";
  const unitP = () => (State.summary && State.summary.unit_plural) || "objets";
  const unitN = (n) => `${n} ${n > 1 ? unitP() : unitS()}`;   // « 3 livres » / « 1 livre »

  // ------------------------------------------------------------------ API
  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch (e) {}
      throw new Error(msg);
    }
    return res;
  }
  const getJSON = (p) => api(p).then((r) => r.json());
  const postJSON = (p, body) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

  // ------------------------------------------------------------ dépôt fichier
  function initUpload() {
    el["dropzone"].addEventListener("click", () => el["file-input"].click());
    el["file-input"].addEventListener("change", (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); });
    ["dragover", "dragenter"].forEach((ev) => el["dropzone"].addEventListener(ev, (e) => { e.preventDefault(); el["dropzone"].classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) => el["dropzone"].addEventListener(ev, (e) => { e.preventDefault(); el["dropzone"].classList.remove("drag"); }));
    el["dropzone"].addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
    el["demo-btn"].addEventListener("click", loadDemo);
  }

  async function handleFile(file) {
    el["upload-err"].textContent = "";
    if (!/\.xlsx?$/i.test(file.name)) { el["upload-err"].textContent = "Déposez un fichier .xlsx."; return; }
    const fd = new FormData(); fd.append("file", file);
    try {
      const up = await api("/upload", { method: "POST", body: fd }).then((r) => r.json());
      onUploaded(up);
    } catch (e) { el["upload-err"].textContent = "Lecture impossible : " + e.message; }
  }

  async function loadDemo() {
    el["upload-err"].textContent = "Chargement de la démonstration…";
    try { onUploaded(await getJSON("/demo")); el["upload-err"].textContent = ""; }
    catch (e) { el["upload-err"].textContent = "Démo indisponible : " + e.message; }
  }

  async function onUploaded(up) {
    State.sessionId = up.session_id; State.filename = up.filename || "Démonstration";
    State.profile = await getJSON(`/profile?session_id=${State.sessionId}`);
    // Nouveau fichier : on repart des suggestions (pas de la config du fichier précédent).
    State.summary = null;
    State.appliedRoles = null; State.appliedUnit = null; State.appliedHingeKey = "";
    State.cardFieldsSel = null;
    showRoles();
    // Raccourci de validation : ?auto=1 construit directement avec les rôles suggérés.
    if (/[?&]auto=1/.test(location.search)) buildGraph();
  }

  // --------------------------------------------------------- écran des rôles
  const ROLE_LABELS = { node: "Nœud", edge: "Lien", attribute: "Info", ignore: "Ignoré" };
  let workingRoles = {};

  // Pluriel français approximatif (miroir de ingest.pluralize_fr) — sert à
  // l'aperçu ; le pluriel officiel est recalculé côté serveur à la configuration.
  function pluralizeFr(w) {
    w = (w || "").trim();
    if (!w) return "";
    const last = w[w.length - 1].toLowerCase();
    if ("sxz".includes(last)) return w;
    if (/(eau|au|eu)$/i.test(w)) return w + "x";   // tableau→tableaux, jeu→jeux
    return w + "s";
  }

  function updateUnitPreview() {
    const p = pluralizeFr(el["unit-singular"].value);
    el["unit-preview"].textContent = p ? `pluriel : ${p}` : "";
  }

  function initUnitField() {
    el["unit-singular"].addEventListener("input", updateUnitPreview);
    // Le choix de regroupement change le compte de nœuds réels → on réévalue.
    el["hinge-key"].addEventListener("change", updateRolesHint);
  }

  function showRoles() {
    // Reprend la dernière config appliquée si elle existe, sinon les suggestions.
    const applied = State.appliedRoles;
    workingRoles = {};
    State.profile.columns.forEach((c) => {
      workingRoles[c.name] = (applied && applied[c.name] != null) ? applied[c.name] : c.suggested_role;
    });
    el["roles-body"].innerHTML = "";
    State.profile.columns.forEach((c) => el["roles-body"].appendChild(rolesRow(c)));
    // Nom de l'unité : valeur appliquée, sinon suggestion dérivée du nom de feuille.
    const su = (State.profile && State.profile.suggested_unit) || { singular: "objet" };
    el["unit-singular"].value = State.appliedUnit != null ? State.appliedUnit : su.singular;
    updateUnitPreview();
    // Colonnes pour le regroupement (clé d'identité de charnière) ; on restaure la sélection.
    el["hinge-key"].innerHTML = `<option value="">(aucune — une ligne = une charnière)</option>` +
      State.profile.columns.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
    el["hinge-key"].value = State.appliedHingeKey || "";
    updateRolesHint();
    el["roles-overlay"].classList.remove("hidden");
  }

  function rolesRow(col) {
    const tr = document.createElement("tr"); tr.className = "rrow";
    const pct = Math.round((col.uniqueness || 0) * 100);
    const roles = ["node", "edge", "attribute", "ignore"].map((r) =>
      `<span class="role ${r} ${workingRoles[col.name] === r ? "on" : ""}" data-role="${r}">${ROLE_LABELS[r]}</span>`).join("");
    tr.innerHTML = `
      <td><div class="col-name">${esc(col.name)}</div><div class="col-sample">${esc((col.samples || []).slice(0, 3).join(", "))}${col.dtype !== "text" ? " · " + col.dtype : ""}</div></td>
      <td class="uniq">${col.n_unique} / ${col.n_filled}<span class="bar"><i style="width:${pct}%"></i></span></td>
      <td><div class="roles">${roles}</div></td>`;
    tr.querySelectorAll(".role").forEach((span) => span.addEventListener("click", () => {
      workingRoles[col.name] = span.dataset.role;
      tr.querySelectorAll(".role").forEach((s) => s.classList.toggle("on", s.dataset.role === span.dataset.role));
      updateRolesHint();
    }));
    return tr;
  }

  function updateRolesHint() {
    const by = { node: [], edge: [], attribute: [] };
    Object.entries(workingRoles).forEach(([k, v]) => { if (by[v]) by[v].push(k); });
    const j = (a) => a.map((x) => esc(x)).join(", ") || "—";
    el["roles-hint"].innerHTML =
      `Nœuds : <b class="n">${j(by.node)}</b> — reliés par <b class="e">${j(by.edge)}</b>. ` +
      `Infos en fiche : <b class="a">${j(by.attribute)}</b>.<br>` +
      `Astuce : passez une colonne « Info » vers « Nœud » et ses valeurs deviennent des points du réseau. La même donnée, une carte différente.`;
    // Avertissement doux : une colonne quasi-unique convient mieux comme lien.
    const uniq = {};
    (State.profile.columns || []).forEach((c) => { uniq[c.name] = c.uniqueness; });
    const tooUnique = by.node.filter((c) => (uniq[c] || 0) >= 0.9);
    if (tooUnique.length) {
      el["roles-hint"].innerHTML +=
        `<br><span style="color:var(--sel)">« ${esc(tooUnique[0])} » n'a presque que des valeurs uniques — elle convient souvent mieux comme <b>lien</b> que comme nœud.</span>`;
    }
    // La clé de regroupement est consommée par l'identité de la charnière : elle
    // ne compte PAS comme entité affichée.
    const hk = el["hinge-key"] ? el["hinge-key"].value : "";
    const keyIsNode = hk && by.node.includes(hk);
    if (keyIsNode) {
      el["roles-hint"].innerHTML +=
        `<br><span style="color:var(--sel)">« ${esc(hk)} » sert de <b>regroupement</b> : ` +
        `elle ne sera pas affichée comme entité. Gardez au moins une <b>autre</b> colonne en « Nœud ».</span>`;
    }
    // Avertissement : une clé à peu de valeurs n'est pas un identifiant d'œuvre —
    // elle fusionnerait tout en quelques méga-charnières reliant presque tout.
    if (hk) {
      const col = (State.profile.columns || []).find((c) => c.name === hk);
      const rows = State.profile.n_rows || 0;
      if (col && rows && col.n_unique > 0 && (col.n_unique <= 2 || rows / col.n_unique > 4)) {
        el["roles-hint"].innerHTML +=
          `<br><span style="color:var(--sel)">« ${esc(hk)} » n'a que ${col.n_unique} valeur(s) distincte(s) → ` +
          `${col.n_unique} charnière(s) qui relieraient presque tout. Une clé doit <b>identifier une œuvre</b> ` +
          `(≈ une valeur par ligne), pas une catégorie (langue, genre, réédition…).</span>`;
      }
    }
    const effectiveNodes = by.node.filter((c) => c !== hk);
    const ok = effectiveNodes.length > 0;
    el["roles-build"].disabled = !ok;
    el["roles-status"].textContent = ok ? "" : (keyIsNode
      ? `« ${hk} » est la clé de regroupement : choisissez une autre colonne « Nœud ».`
      : "Choisissez au moins une colonne « Nœud ».");
  }

  el["roles-cancel"].addEventListener("click", () => el["roles-overlay"].classList.add("hidden"));
  el["reconfig"].addEventListener("click", showRoles);
  el["roles-build"].addEventListener("click", buildGraph);

  async function buildGraph() {
    el["roles-status"].innerHTML = `<span class="spinner"></span> Construction…`;
    try {
      const cfg = await postJSON("/configure", {
        session_id: State.sessionId, roles: workingRoles,
        unit_singular: el["unit-singular"].value,   // le pluriel est dérivé côté serveur
        hinge_key: el["hinge-key"].value || null,   // regroupement de lignes (optionnel)
      });
      State.summary = cfg.summary;
      // Mémorise la config pour la restaurer si on rouvre l'écran des rôles.
      State.appliedRoles = { ...workingRoles };
      // Vide (ou espaces) = « non défini » : le backend retombe sur la suggestion,
      // donc on mémorise null pour réafficher cette suggestion à la réouverture.
      State.appliedUnit = el["unit-singular"].value.trim() || null;
      State.appliedHingeKey = el["hinge-key"].value || "";
      el["roles-overlay"].classList.add("hidden");
      startApp();
    } catch (e) { el["roles-status"].textContent = "Erreur : " + e.message; }
  }

  // -------------------------------------------------------- démarrage de l'app
  function startApp() {
    el["upload-screen"].classList.add("hidden");
    el["app"].classList.remove("hidden");
    el["brand-sub"].textContent = State.filename;

    State.layersOn = new Set(State.summary.node_layers);
    State.pivot = null;
    State.fullYearMin = State.summary.year_min; State.fullYearMax = State.summary.year_max;
    State.yearMin = State.summary.year_min; State.yearMax = State.summary.year_max;
    State.layoutSig = null;

    if (!window.__netInit) {
      NetView.init({
        container: $("sigma"), cards: $("cards"), tooltip: $("tooltip"),
        statusEl: el["statusline"], timeAxis: el["time-axis"],
        onSelect: selectNode, onBackground: deselect,
      });
      window.__netInit = true;
      window.addEventListener("resize", () => {
        NetView.resize();
        if (State.fullYearMin != null) { drawHistogram(); positionWindow(); }
      });
    }

    // Libellés dérivés du nom d'unité choisi à la configuration.
    el["hinge-label"].textContent = cap(unitP());
    el["hinge-layer"].title = `Afficher les ${unitP()} comme nœuds-charnières`;
    if (el["chrono-sub"]) el["chrono-sub"].textContent =
      `Une ligne par entité ; chaque point est un ${unitS()} placé dans le temps.`;
    NetView.setUnitLabels(unitS(), unitP());
    // Le graphe vient d'être (re)construit → cartes invalidées, rechargées à la demande
    // (au 1er affichage de la couche charnière) plutôt qu'à chaque cran du curseur.
    State.cardsLoaded = false;
    NetView.setCardData({});
    if (State.showHinge) ensureCardData();

    buildPivotList();
    buildLayers();
    buildCardFields();
    buildTimeline();
    toggleTemporalUI(State.fullYearMin != null);
    el["rail-foot"].textContent =
      `${State.summary.n_works} ${unitP()} · ${State.summary.n_nodes_total} entités`;
    refreshGraph();
  }

  // Champs affichés sur la carte d'un livre (charnière). Réglable à la volée :
  // c'est purement de l'affichage, les valeurs sont déjà toutes envoyées par /graph.
  function buildCardFields() {
    const layers = State.summary.node_layers || [];
    const attrs = State.summary.attr_cols || [];
    const tc = State.summary.time_col;
    const fields = [...layers, ...attrs];
    if (tc && !fields.includes(tc)) fields.push(tc);
    // Sélection : mémorisée (filtrée aux colonnes encore présentes) si l'utilisateur
    // a déjà choisi ; sinon défaut adaptatif = entités liées + année (fiche biblio).
    const sel = State.cardFieldsSel != null
      ? new Set(State.cardFieldsSel.filter((f) => fields.includes(f)))
      : new Set([...layers, tc].filter(Boolean));
    el["card-fields"].innerHTML = "";
    fields.forEach((f) => {
      const row = document.createElement("label");
      row.className = "cf";
      row.innerHTML = `<input type="checkbox" ${sel.has(f) ? "checked" : ""}> <span>${esc(f)}</span>`;
      row.querySelector("input").dataset.field = f;
      row.querySelector("input").addEventListener("change", onCardFieldChange);
      el["card-fields"].appendChild(row);
    });
    syncCardFields();              // applique sans écraser la mémoire
    updateCardFieldsState();
  }

  function syncCardFields() {
    State.cardFields = [...el["card-fields"].querySelectorAll("input")]
      .filter((i) => i.checked).map((i) => i.dataset.field);
    NetView.setCardFields(State.cardFields);
  }

  function onCardFieldChange() {
    syncCardFields();
    State.cardFieldsSel = State.cardFields.slice();   // mémorise le choix de l'utilisateur
  }

  // La carte d'un livre n'apparaît que si la charnière est affichée → on grise
  // le contrôle (et on explique) tant que ce n'est pas le cas.
  function updateCardFieldsState() {
    const on = !!State.showHinge;
    el["card-fields"].classList.toggle("inactive", !on);
    if (el["card-fields-note"]) el["card-fields-note"].classList.toggle("show", !on);
  }

  // ------------------------------------------------------------- pivot & couches
  function buildPivotList() {
    el["pivot-list"].innerHTML = "";
    const mk = (label, value) => {
      const b = document.createElement("button");
      b.innerHTML = `<span class="pin"></span>${esc(label)}`;
      b.classList.toggle("on", State.pivot === value);
      b.addEventListener("click", () => setPivot(value));
      return b;
    };
    el["pivot-list"].appendChild(mk("Aucun (force libre)", null));
    State.summary.node_layers.forEach((t) => el["pivot-list"].appendChild(mk(t, t)));
  }

  function setPivot(value) {
    State.pivot = value;
    el["pivot-list"].querySelectorAll("button").forEach((b, i) => {
      const v = i === 0 ? null : State.summary.node_layers[i - 1];
      b.classList.toggle("on", v === value);
    });
    refreshGraph({ pivotChanged: true });
  }

  function buildLayers() {
    el["layers-list"].innerHTML = "";
    State.summary.node_layers.forEach((t) => {
      const row = document.createElement("label");
      row.className = "layer";
      const color = State.summary.palette[t] || "#8A857B";
      const count = State.summary.type_counts[t] || 0;
      row.innerHTML = `<span class="tog"></span><span class="sw" style="background:${color}"></span>${esc(t)}<span class="ct">${count}</span>`;
      row.addEventListener("click", () => {
        if (State.layersOn.has(t)) State.layersOn.delete(t); else State.layersOn.add(t);
        row.classList.toggle("off", !State.layersOn.has(t));
        refreshGraph();
      });
      el["layers-list"].appendChild(row);
    });
    el["hinge-layer"].classList.toggle("off", !State.showHinge);
    el["hinge-layer"].onclick = () => {
      State.showHinge = !State.showHinge;
      el["hinge-layer"].classList.toggle("off", !State.showHinge);
      updateCardFieldsState();
      if (State.showHinge) ensureCardData();   // 1re activation → charge les cartes
      refreshGraph();
    };
  }

  // --------------------------------------------------------------- timeline
  const TL_PAD = 7;                 // demi-largeur de poignée (alignement frise ↔ poignées)
  let refreshTimer = null;

  async function buildTimeline() {
    if (State.fullYearMin == null) { el["timewrap"].style.display = "none"; return; }
    el["timewrap"].style.display = "";
    // Histogramme : compte d'ouvrages par année (graphe maître).
    try {
      const tl = await getJSON(`/timeline?session_id=${State.sessionId}`);
      State.tlCounts = tl.counts || [];
      State.tlMax = Math.max(1, ...State.tlCounts.map((c) => c.count));
    } catch (e) { State.tlCounts = []; State.tlMax = 1; }

    [el["yr-min"], el["yr-max"]].forEach((s) => { s.min = State.fullYearMin; s.max = State.fullYearMax; });
    applyRange(State.fullYearMin, State.fullYearMax, "none");

    // Poignées (réglage fin)
    el["yr-min"].oninput = () => {
      if (State.timeMode === "window") return applyWindowStart(+el["yr-min"].value, "debounced");
      applyRange(+el["yr-min"].value, State.yearMax, "debounced", "min");
    };
    el["yr-max"].oninput = () => applyRange(State.yearMin, +el["yr-max"].value, "debounced", "max");

    setupBrush();
    el["yr-reset"].onclick = () => { stopPlay(); applyRange(State.fullYearMin, State.fullYearMax, "now"); };
    requestAnimationFrame(drawHistogram);   // attend la mise en page pour la largeur réelle
  }

  // --- cœur : applique une plage [lo,hi], met à jour UI + (éventuellement) la carte
  function applyRange(lo, hi, refresh, anchor) {
    lo = clamp(lo, State.fullYearMin, State.fullYearMax);
    hi = clamp(hi, State.fullYearMin, State.fullYearMax);
    if (lo > hi) { if (anchor === "min") hi = lo; else if (anchor === "max") lo = hi; else [lo, hi] = [hi, lo]; }
    State.yearMin = lo; State.yearMax = hi;
    el["yr-min"].value = lo; el["yr-max"].value = hi;
    el["yr-lo"].textContent = lo; el["yr-hi"].textContent = hi;
    drawHistogram(); positionWindow();
    if (refresh === "now") refreshGraph();
    else if (refresh === "debounced") { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refreshGraph(), 130); }
  }
  function applyWindowStart(start, refresh) {
    const w = State.windowWidth;
    start = clamp(start, State.fullYearMin, State.fullYearMax - w + 1);
    applyRange(start, start + w - 1, refresh, "min");
  }

  function tlWidth() { return el["tl"].clientWidth || 240; }
  function yearToX(y) {
    const span = (State.fullYearMax - State.fullYearMin) || 1;
    return TL_PAD + ((y - State.fullYearMin) / span) * (tlWidth() - 2 * TL_PAD);
  }
  function xToYear(x) {
    const span = (State.fullYearMax - State.fullYearMin) || 1;
    const frac = clamp((x - TL_PAD) / (tlWidth() - 2 * TL_PAD), 0, 1);
    return Math.round(State.fullYearMin + frac * span);
  }

  function positionWindow() {
    const x0 = yearToX(State.yearMin), x1 = yearToX(State.yearMax);
    el["tl-window"].style.left = x0 + "px";
    el["tl-window"].style.width = Math.max(2, x1 - x0) + "px";
  }

  function drawHistogram() {
    const cv = el["tl-hist"]; if (!cv) return;
    const W = tlWidth(), H = 32, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + "px"; cv.style.height = H + "px";
    const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const span = (State.fullYearMax - State.fullYearMin) || 1;
    const bw = Math.max(2, ((W - 2 * TL_PAD) / (span + 1)) * 0.78);
    State.tlCounts.forEach((c) => {
      const x = yearToX(c.year), h = (c.count / State.tlMax) * (H - 4);
      const inRange = c.year >= State.yearMin && c.year <= State.yearMax;
      g.fillStyle = inRange ? "#C07A1A" : "#E0DBD0";
      g.fillRect(x - bw / 2, H - h, bw, h);
    });
  }

  // --- brush : cliquer/glisser sur la frise ajuste la plage (la piste laisse passer
  //     les events, seules les poignées capturent — voir CSS pointer-events)
  function setupBrush() {
    let anchorYear = null;
    const down = (e) => {
      if (e.target.tagName === "INPUT") return;     // une poignée : laisser le natif gérer
      stopPlay();
      anchorYear = xToYear(e.clientX - el["tl"].getBoundingClientRect().left);
      if (State.timeMode === "window") applyWindowStart(anchorYear, "debounced");
      else applyRange(anchorYear, anchorYear, "debounced");
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      e.preventDefault();
    };
    const move = (e) => {
      const y = xToYear(e.clientX - el["tl"].getBoundingClientRect().left);
      if (State.timeMode === "window") applyWindowStart(y, "debounced");
      else applyRange(Math.min(anchorYear, y), Math.max(anchorYear, y), "debounced");
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      refreshGraph();      // version « now » à la fin du geste
    };
    el["tl"].addEventListener("mousedown", down);
  }

  // --- modes cumulatif / fenêtre glissante
  function setTimeMode(mode) {
    State.timeMode = mode;
    el["ctrl-window"].style.display = mode === "window" ? "" : "none";
    el["tl"].classList.toggle("window-mode", mode === "window");
    if (mode === "window") applyWindowStart(State.yearMin, "now");
    else applyRange(State.yearMin, State.fullYearMax, "now");
  }

  // --- lecture animée
  function togglePlay() { State.playing ? stopPlay() : startPlay(); }
  function startPlay() {
    if (State.fullYearMin == null) return;
    State.playing = true;
    el["tl-play"].textContent = "⏸"; el["tl-play"].classList.add("playing");
    // (re)part du début si on est déjà au bout
    if (State.timeMode === "window") {
      if (State.yearMin + State.windowWidth - 1 >= State.fullYearMax) applyWindowStart(State.fullYearMin, "none");
    } else if (State.yearMax >= State.fullYearMax) {
      applyRange(State.yearMin, State.yearMin, "none");
    }
    playFrame();
  }
  function stopPlay() {
    State.playing = false;
    el["tl-play"].textContent = "▶"; el["tl-play"].classList.remove("playing");
  }
  async function playFrame() {
    if (!State.playing) return;
    await refreshGraph();
    if (!State.playing) return;
    await sleep(State.playSpeed);
    if (!State.playing) return;
    advanceTime();
    playFrame();
  }
  function advanceTime() {
    if (State.timeMode === "window") {
      const last = State.yearMin + State.windowWidth - 1;
      const next = last >= State.fullYearMax ? State.fullYearMin : State.yearMin + 1;
      applyWindowStart(next, "none");
    } else {
      const next = State.yearMax >= State.fullYearMax ? State.yearMin : State.yearMax + 1;
      applyRange(State.yearMin, next, "none");
    }
  }

  // ----------------------------------------------------- options avancées (segs)
  function wireSeg(segEl, apply) {
    segEl.querySelectorAll("span").forEach((s) => s.addEventListener("click", () => {
      segEl.querySelectorAll("span").forEach((x) => x.classList.toggle("on", x === s));
      apply(s.dataset.v);
    }));
  }
  function initControls() {
    el["adv-toggle"].addEventListener("click", () => el["adv"].classList.toggle("open"));
    wireSeg(el["seg-link"], (v) => { State.linkMode = v; refreshGraph(); });
    wireSeg(el["seg-pivot"], (v) => { State.pivotMode = v; refreshGraph({ pivotChanged: true }); });
    wireSeg(el["seg-color"], (v) => { State.colorBy = v; refreshGraph(); });
    wireSeg(el["seg-labels"], (v) => { State.labels = v; NetView.setLabelsDensity(v); });
    wireSeg(el["display-mode"], (v) => { State.displayMode = v; NetView.setDisplayMode(v); });
    el["size-by"].addEventListener("change", (e) => { State.sizeBy = e.target.value; refreshGraph(); });
    el["layout-sel"].addEventListener("change", (e) => { State.layout = e.target.value; State.layoutSig = null; refreshGraph(); });
    el["search"].addEventListener("input", (e) => { State.search = e.target.value; NetView.applySearch(e.target.value); });
    el["dclose"].addEventListener("click", deselect);
    el["share-btn"].addEventListener("click", shareStub);
    el["export-btn"].addEventListener("click", () => el["export-overlay"].classList.remove("hidden"));
    // contrôles temporels
    wireSeg(el["seg-timemode"], setTimeMode);
    el["window-width"].addEventListener("input", (e) => {
      State.windowWidth = +e.target.value; el["window-width-val"].textContent = e.target.value;
      if (State.timeMode === "window") applyWindowStart(State.yearMin, "now");
    });
    el["tl-play"].addEventListener("click", togglePlay);
    el["tl-speed"].addEventListener("change", (e) => { State.playSpeed = +e.target.value; });
    el["snapshots-btn"].addEventListener("click", openSnapshots);
    el["chrono-btn"].addEventListener("click", openChronology);
    initExport();
    initSnapshots();
    initChronology();
  }

  // ---------------------------------------------------------- rafraîchir la carte
  function queryString() {
    const p = new URLSearchParams();
    p.set("session_id", State.sessionId);
    p.set("layers", [...State.layersOn].join(","));
    p.set("link_mode", State.linkMode);
    p.set("show_hinge", State.showHinge);
    p.set("color_by", State.colorBy);
    p.set("size_by", State.sizeBy);
    if (State.pivot) p.set("pivot", State.pivot);
    if (State.yearMin != null) { p.set("year_min", State.yearMin); p.set("year_max", State.yearMax); }
    return p.toString();
  }
  function layoutSignature() {
    return JSON.stringify({
      l: [...State.layersOn].sort(), link: State.linkMode, hinge: State.showHinge,
      lay: State.layout, piv: State.pivotMode === "reorganize" ? State.pivot : null,
    });
  }

  // Cartes des charnières : invariantes par projection → chargées une seule fois
  // (à la 1re activation de la couche charnière) et réutilisées par le rendu.
  async function ensureCardData() {
    if (State.cardsLoaded) return;
    State.cardsLoaded = true;                  // évite les requêtes concurrentes
    try {
      const map = await getJSON("/cards?session_id=" + encodeURIComponent(State.sessionId));
      NetView.setCardData(map);
    } catch (e) { State.cardsLoaded = false; flash("Erreur cartes : " + e.message); }
  }

  async function refreshGraph(opts) {
    opts = opts || {};
    try {
      const data = await getJSON("/graph?" + queryString());
      State.lastGraph = data;
      const sig = layoutSignature();
      const relayout = sig !== State.layoutSig;
      NetView.render(data, {
        relayout, layoutKind: State.layout,
        pivot: State.pivot, pivotMode: State.pivotMode,
        yearMin: State.fullYearMin, yearMax: State.fullYearMax,
      });
      State.layoutSig = sig;
      NetView.setLabelsDensity(State.labels);
      updateEpochLegend(data.epoch_legend);
      // pivot en mode « filtre seul » : on met en évidence + centre, sans relayouter
      if (State.pivot && State.pivotMode === "filter") {
        const ids = data.nodes.filter((n) => n.type === State.pivot).map((n) => n.id);
        NetView.setFocus(ids); NetView.centerOnNodes(ids);
      } else if (opts.pivotChanged && State.pivot) {
        const ids = data.nodes.filter((n) => n.type === State.pivot).map((n) => n.id);
        NetView.centerOnNodes(ids);
      } else if (opts.pivotChanged && !State.pivot && !State.selected) {
        NetView.setFocus(null);
      }
      if (State.selected && !data.nodes.find((n) => n.id === State.selected)) deselect();
      if (!State.playing) hintDegenerate(data);
    } catch (e) { flash("Erreur : " + e.message); }
  }

  // Explique une vue vide de sens (0 nœud / 0 lien) au lieu de la laisser muette.
  function hintDegenerate(data) {
    const n = data.nodes.length, e = data.edges.length;
    if (n === 0) {
      flash("Aucun élément avec ces filtres — élargissez la plage d'années ou réaffichez des couches.");
    } else if (e === 0 && n > 1) {
      flash(State.linkMode === "cut" && !State.showHinge
        ? "0 lien : en mode « se coupent » avec la charnière masquée, le réseau se déconnecte. Repassez en « se reportent », ou affichez la charnière."
        : "0 lien : ces nœuds ne partagent rien dans la vue actuelle.");
    }
  }

  // ------------------------------------------------------------- sélection
  async function selectNode(id) {
    State.selected = id;
    NetView.setHighlight(id);
    try {
      let url = `/node/${encodeURIComponent(id)}?session_id=${State.sessionId}`;
      if (State.yearMin != null) url += `&year_min=${State.yearMin}&year_max=${State.yearMax}`;
      renderDetail(await getJSON(url));
    } catch (e) { flash("Détail indisponible : " + e.message); }
  }

  function deselect() {
    State.selected = null;
    NetView.setHighlight(null);
    el["detail"].classList.remove("open");
  }

  function renderDetail(d) {
    const meta = (State.lastGraph.nodes || []).find((n) => n.id === d.id) || {};
    const color = d.color || meta.color || "#8A857B";
    el["dhead"].style.background = color;
    el["d-title"].textContent = d.label;
    el["d-sub"].textContent = d.kind === "work" ? cap(unitS()) : d.type;

    let html = "";
    if (d.kind === "work") {
      if (d.year != null) html += stat("Année", d.year);
      Object.entries(d.attributes || {}).forEach(([k, v]) => { html += stat(k, v); });
      Object.entries(d.neighbors_by_type || {}).forEach(([t, arr]) => { html += stat(t, arr.join(", ")); });
    } else {
      html += stat(cap(unitP()), unitN(d.work_count));
      if (d.period) html += stat("Période d'activité", d.period[0] === d.period[1] ? d.period[0] : `${d.period[0]} – ${d.period[1]}`);
      if (meta.community != null) html += stat("Communauté", "Groupe " + (meta.community + 1));
      if (meta.degree != null) html += stat("Centralité (degré)", meta.degree_raw + " liens" + (meta.size >= 16 ? " — nœud pivot" : ""));
      Object.entries(d.neighbors_by_type || {}).forEach(([t, arr]) => {
        html += `<div class="stat"><div class="k">${esc(t)}</div><div class="v">${arr.slice(0, 12).map((x) => `<span class="dtag">${esc(x)}</span>`).join("")}</div></div>`;
      });
      if (d.works && d.works.length) {
        html += `<div class="k" style="font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:bold;margin:6px 0 8px">${esc(cap(unitP()))}</div>`;
        d.works.forEach((w) => {
          const partners = Object.values(w.partners || {}).flat().slice(0, 3).join(" · ");
          html += `<div class="work"><div class="t">${esc(w.label)}</div><div class="s">${esc(partners)}${w.year ? " — " + w.year : ""}</div></div>`;
        });
      }
    }
    el["dbody"].innerHTML = html;
    el["detail"].classList.add("open");
  }
  function stat(k, v) { return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`; }

  // ------------------------------------------------------------------ export
  function initExport() {
    el["exp-close"].addEventListener("click", () => el["export-overlay"].classList.add("hidden"));
    el["exp-image"].addEventListener("click", () => doExport("image", el["exp-format"].value));
    document.querySelectorAll("[data-exp]").forEach((b) =>
      b.addEventListener("click", () => doExport(b.dataset.exp, b.dataset.fmt || "csv")));
  }

  function currentView() {
    let idFilter = null;
    if (el["exp-scope"].value === "neighbors" && State.selected) {
      idFilter = NetView.neighborhood(State.selected, +el["exp-hops"].value);
    }
    return { nodes: NetView.getViewNodes(idFilter), edges: NetView.getViewEdges(idFilter) };
  }

  async function doExport(kind, format) {
    el["exp-status"].innerHTML = `<span class="spinner"></span> Préparation…`;
    try {
      const body = {
        session_id: State.sessionId, kind, format,
        dimensions: el["exp-dim"].value, labels: el["exp-labels"].value,
        title: State.filename, view: currentView(),
        unit_singular: unitS(), unit_plural: unitP(),
      };
      // réseau temporel : on joint l'axe des années pour qu'il figure dans l'image
      if (kind === "image" && State.layout === "temporal" && State.fullYearMin != null) {
        body.time_axis = { year_min: State.fullYearMin, year_max: State.fullYearMax, width: NetView.temporalWidth };
      }
      const res = await api("/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="?([^"]+)"?/);
      downloadBlob(blob, m ? m[1] : `cartographie.${format}`);
      el["exp-status"].textContent = "Téléchargé ✓";
    } catch (e) { el["exp-status"].textContent = "Échec : " + e.message; }
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // ----------------------------------------- instantanés (petits multiples)
  let snapPanels = [];

  function initSnapshots() {
    el["snap-close"].addEventListener("click", () => el["snapshots-overlay"].classList.add("hidden"));
    el["snap-interval"].addEventListener("change", buildSnapshots);
    el["snap-cumulative"].addEventListener("change", buildSnapshots);
    document.querySelectorAll("[data-snapexp]").forEach((b) =>
      b.addEventListener("click", () => exportSnapshots(b.dataset.snapexp)));
  }

  function openSnapshots() {
    if (State.fullYearMin == null) { flash("Pas de dimension temporelle dans ces données."); return; }
    stopPlay();
    el["snapshots-overlay"].classList.remove("hidden");
    buildSnapshots();
  }

  function computePeriods() {
    const lo = State.fullYearMin, hi = State.fullYearMax, iv = +el["snap-interval"].value;
    const periods = [];
    if (iv > 0) {
      for (let a = Math.floor(lo / iv) * iv; a <= hi; a += iv) {
        const s = Math.max(a, lo), e = Math.min(a + iv - 1, hi);
        if (e >= lo) periods.push([s, e]);
      }
    } else {
      const k = Math.min(8, Math.max(2, hi - lo)), step = (hi - lo + 1) / k;
      for (let i = 0; i < k; i++) {
        const s = Math.round(lo + i * step);
        const e = i === k - 1 ? hi : Math.round(lo + (i + 1) * step) - 1;
        if (e >= s) periods.push([s, e]);
      }
    }
    return periods;
  }

  function sumWorks(lo, hi) {
    return State.tlCounts.filter((c) => c.year >= lo && c.year <= hi).reduce((s, c) => s + c.count, 0);
  }

  async function buildSnapshots() {
    const cumulative = el["snap-cumulative"].checked;
    const periods = computePeriods();
    el["snap-status"].innerHTML = `<span class="spinner"></span> Calcul…`;
    el["snap-grid"].innerHTML = "";
    const positions = NetView.getPositions();
    const px = Object.values(positions).map((p) => p.x), py = Object.values(positions).map((p) => p.y);
    const bounds = px.length
      ? { minx: Math.min(...px), maxx: Math.max(...px), miny: Math.min(...py), maxy: Math.max(...py) }
      : { minx: -1, maxx: 1, miny: -1, maxy: 1 };
    snapPanels = [];
    for (const [a, b] of periods) {
      const lo = cumulative ? State.fullYearMin : a;
      const p = new URLSearchParams({
        session_id: State.sessionId, layers: [...State.layersOn].join(","),
        link_mode: State.linkMode, show_hinge: State.showHinge,
        color_by: State.colorBy, size_by: State.sizeBy, year_min: lo, year_max: b,
      });
      let data;
      try { data = await getJSON("/graph?" + p.toString()); } catch (e) { continue; }
      const nodes = data.nodes.map((n) => {
        const pos = positions[n.id] || { x: n.x, y: n.y };
        return { id: n.id, label: n.label, color: n.color, size: n.size, x: pos.x, y: pos.y };
      });
      const title = cumulative ? `≤ ${b}` : (a === b ? `${a}` : `${a}–${b}`);
      const panel = { title, count: sumWorks(lo, b), nodes, edges: data.edges };
      snapPanels.push(panel);
      el["snap-grid"].appendChild(snapCell(panel, bounds));
    }
    el["snap-status"].textContent = snapPanels.length
      ? `${snapPanels.length} instantanés · mêmes positions` : "Aucune période";
  }

  function snapCell(panel, b) {
    const cell = document.createElement("div"); cell.className = "snap-cell";
    const W = (b.maxx - b.minx) || 2, H = (b.maxy - b.miny) || 2, ext = Math.max(W, H);
    const pad = ext * 0.07 + 0.5;
    const vb = `${b.minx - pad} ${-(b.maxy + pad)} ${W + 2 * pad} ${H + 2 * pad}`; // axe y inversé (SVG)
    const pos = {}; panel.nodes.forEach((n) => { pos[n.id] = { x: n.x, y: -n.y }; });
    const lw = ext * 0.0016;
    let svg = "";
    panel.edges.forEach((e) => {
      const s = pos[e.source], t = pos[e.target];
      if (s && t) svg += `<line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}" stroke="#CFC9BD" stroke-width="${lw}"/>`;
    });
    panel.nodes.forEach((n) => {
      const r = ext * (0.007 + 0.013 * (n.size / 22));
      svg += `<circle cx="${pos[n.id].x}" cy="${pos[n.id].y}" r="${r}" fill="${n.color}" stroke="#fff" stroke-width="${r * 0.2}"/>`;
    });
    cell.innerHTML =
      `<div class="cap"><span class="per">${esc(panel.title)}</span><span class="cnt">${esc(unitN(panel.count))}</span></div>` +
      `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet" style="aspect-ratio:${(W + 2 * pad) / (H + 2 * pad)}">${svg}</svg>`;
    return cell;
  }

  async function exportSnapshots(fmt) {
    if (!snapPanels.length) { el["snap-status"].textContent = "Rien à exporter."; return; }
    el["snap-status"].innerHTML = `<span class="spinner"></span> Export…`;
    try {
      const res = await api("/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: State.sessionId, kind: "small_multiples",
          format: fmt, title: `Instantanés — ${State.filename}`, panels: snapPanels,
          unit_singular: unitS(), unit_plural: unitP() }),
      });
      downloadBlob(await res.blob(), `instantanes.${fmt}`);
      el["snap-status"].textContent = "Téléchargé ✓";
    } catch (e) { el["snap-status"].textContent = "Échec : " + e.message; }
  }

  // ----------------------------------------- chronologie (dot-plot par entité)
  let chronoData = null;

  function initChronology() {
    el["chrono-close"].addEventListener("click", () => el["chrono-overlay"].classList.add("hidden"));
    el["chrono-pivot"].addEventListener("change", buildChronology);
    el["chrono-color"].addEventListener("change", buildChronology);
    document.querySelectorAll("[data-chronoexp]").forEach((b) =>
      b.addEventListener("click", () => exportChronology(b.dataset.chronoexp)));
  }

  function openChronology() {
    const layers = State.summary.node_layers || [];
    el["chrono-pivot"].innerHTML = layers.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
    el["chrono-pivot"].value = State.pivot || layers[0] || "";
    el["chrono-color"].innerHTML = `<option value="">(aucune)</option>` +
      (State.summary.attr_cols || []).map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
    el["chrono-overlay"].classList.remove("hidden");
    buildChronology();
  }

  async function buildChronology() {
    el["chrono-status"].innerHTML = `<span class="spinner"></span> Calcul…`;
    const p = new URLSearchParams({ session_id: State.sessionId });
    if (el["chrono-pivot"].value) p.set("pivot_type", el["chrono-pivot"].value);
    if (el["chrono-color"].value) p.set("color_attr", el["chrono-color"].value);
    try {
      chronoData = await getJSON("/chronology?" + p.toString());
      el["chrono-title"].textContent = `Chronologie — ${chronoData.pivot_type}`;
      renderChronoSVG(chronoData);
      el["chrono-status"].textContent = `${chronoData.entities.length} entités`;
    } catch (e) { el["chrono-status"].textContent = "Erreur : " + e.message; el["chrono-scroll"].innerHTML = ""; }
  }

  function renderChronoSVG(d) {
    const ents = d.entities;
    if (!ents.length) { el["chrono-scroll"].innerHTML = `<p style="padding:20px;color:var(--muted)">Aucune donnée temporelle pour ce type.</p>`; return; }
    const W = 1000, ML = 210, MR = 30, MT = 16, MB = 42, RH = 26;
    const H = MT + ents.length * RH + MB;
    const x0 = ML, x1 = W - MR, ymin = d.year_min, ymax = d.year_max, span = (ymax - ymin) || 1;
    const xFor = (yr) => x0 + ((yr - ymin) / span) * (x1 - x0);
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet">`;
    const step = niceStep(span);
    for (let yr = Math.ceil(ymin / step) * step; yr <= ymax; yr += step) {
      const x = xFor(yr);
      svg += `<line class="chrono-grid" x1="${x}" y1="${MT}" x2="${x}" y2="${H - MB}"/>`;
      svg += `<text class="chrono-axis" x="${x}" y="${H - MB + 16}" text-anchor="middle">${yr}</text>`;
    }
    ents.forEach((e, i) => {
      const y = MT + i * RH + RH / 2;
      svg += `<rect class="chrono-row-bg" x="0" y="${MT + i * RH}" width="${W}" height="${RH}" fill="transparent"/>`;
      svg += `<text class="chrono-lbl" x="${ML - 12}" y="${y + 4}" text-anchor="end">${esc(trunc(e.label, 30))}</text>`;
      if (e.first !== e.last) svg += `<line class="chrono-life" x1="${xFor(e.first)}" y1="${y}" x2="${xFor(e.last)}" y2="${y}"/>`;
      e.works.forEach((w) => {
        const info = `${w.title} — ${w.year}` + (w.color_value ? ` · ${w.color_value}` : "");
        svg += `<circle class="chrono-dot" cx="${xFor(w.year)}" cy="${y}" r="5.5" fill="${w.color}"><title>${esc(info)}</title></circle>`;
      });
    });
    const cm = Object.entries(d.color_map || {});
    if (cm.length) {
      let lx = ML;
      cm.forEach(([v, c]) => {
        svg += `<circle cx="${lx}" cy="${H - 12}" r="5" fill="${c}"/><text class="chrono-leg" x="${lx + 9}" y="${H - 8}">${esc(v)}</text>`;
        lx += 26 + String(v).length * 7;
      });
    }
    svg += `</svg>`;
    el["chrono-scroll"].innerHTML = svg;
  }

  async function exportChronology(fmt) {
    if (!chronoData || !chronoData.entities.length) { el["chrono-status"].textContent = "Rien à exporter."; return; }
    el["chrono-status"].innerHTML = `<span class="spinner"></span> Export…`;
    try {
      const res = await api("/export", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: State.sessionId, kind: "chronology", format: fmt,
          title: `Chronologie — ${chronoData.pivot_type}`, view: chronoData,
          unit_singular: unitS(), unit_plural: unitP() }) });
      downloadBlob(await res.blob(), `chronologie.${fmt}`);
      el["chrono-status"].textContent = "Téléchargé ✓";
    } catch (e) { el["chrono-status"].textContent = "Échec : " + e.message; }
  }

  // ------------------------------------------------------------------ divers
  function shareStub() {
    flash("Partage : fonctionnalité de démonstration (lien non généré).");
  }
  let flashT = null;
  function flash(msg) {
    el["statusline"].textContent = msg; el["statusline"].style.opacity = "1";
    clearTimeout(flashT); flashT = setTimeout(() => { el["statusline"].textContent = NetView.getMetrics().nodes + " nœuds · " + NetView.getMetrics().edges + " liens"; }, 2600);
  }
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function niceStep(span) {
    for (const s of [1, 2, 5, 10, 20, 25, 50, 100]) if (span / s <= 10) return s;
    return 200;
  }
  // Masque les fonctions temporelles si le tableur n'a pas de colonne d'année
  // (sinon elles produiraient des vues vides) — généricité.
  function toggleTemporalUI(hasTime) {
    const show = hasTime ? "" : "none";
    el["chrono-btn"].style.display = show;
    el["snapshots-btn"].style.display = show;
    const epochSpan = document.querySelector('#seg-color span[data-v="epoch"]');
    if (epochSpan) epochSpan.style.display = show;
    const tempOpt = document.querySelector('#layout-sel option[value="temporal"]');
    if (tempOpt) { tempOpt.disabled = !hasTime; tempOpt.style.display = show; }
    if (!hasTime) {
      if (State.colorBy === "epoch") { State.colorBy = "type"; resetSeg("seg-color", "type"); }
      if (State.layout === "temporal") { State.layout = "force"; el["layout-sel"].value = "force"; }
    }
  }
  function resetSeg(id, v) {
    el[id].querySelectorAll("span").forEach((s) => s.classList.toggle("on", s.dataset.v === v));
  }

  function updateEpochLegend(legend) {
    if (State.colorBy !== "epoch" || !legend || legend.year_min == null) { el["epoch-legend"].classList.add("hidden"); return; }
    el["epoch-legend"].classList.remove("hidden");
    el["el-min"].textContent = legend.year_min;
    el["el-max"].textContent = legend.year_max;
    const stops = (legend.stops || []).map((s) => `${s.color} ${Math.round(s.pos * 100)}%`).join(",");
    if (stops) el["el-bar"].style.background = `linear-gradient(90deg,${stops})`;
  }

  // ------------------------------------------------------------------ boot
  initUpload();
  initControls();
  initUnitField();
  // Raccourci de validation/démo : ?auto=1 charge la démo et construit la carte.
  if (/[?&]auto=1/.test(location.search)) loadDemo();
})();
