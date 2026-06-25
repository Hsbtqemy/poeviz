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
    connectors: new Set(),       // couches « connecteur » (relient sans être affichées)
    pivot: null,                 // type d'entité (colonne) ou null
    linkMode: "report",
    pivotMode: "reorganize",
    colorBy: "type",
    sizeBy: "degree",
    labels: "pivots",
    displayMode: "auto",
    layout: "force",
    axisX: "free", axisY: "force", axisOrder: "alpha",   // disposition « axes »
    force: { linLog: false, outbound: false, edgeWeight: 1, groupByCommunity: false },
    simAttract: false, simDims: [], simThreshold: 0.5,   // similarité (T4) : rapprocher les semblables
    focus: null, focusHops: 1, focusTrail: [],           // mode focalisation (ego)
    parcours: [],                 // chaîne de nœuds (fil d'Ariane) du parcours courant
    parcoursPlaying: false,       // animation « rejouer le parcours » en cours ?
    showHinge: false,
    degreeMin: 0,                 // filtre « degré minimum » (0 = aucun filtre)
    filterCols: [],               // colonnes filtrables [{col,n_unique,role,is_time}] (/configure)
    facetValues: {},              // {colonne: [valeurs]} — chargé à la demande (/facet-values)
    facetCounts: {},              // {colonne: {valeur: occurrences}}
    facetSort: {},                // {colonne: "alpha"|"count"} — tri des valeurs
    facetTrunc: {},               // {colonne: bool} — liste tronquée (quasi-unique)
    facets: {},                   // {colonne: Set(valeurs cochées)} ; tout coché = pas de filtre
    yearMin: null, yearMax: null,
    fullYearMin: null, fullYearMax: null,
    timeMode: "cumulative",       // cumulative | window
    windowWidth: 5,
    playing: false, playSpeed: 550,
    tlCounts: [], tlMax: 1,
    search: "",
    selected: null,
    lastGraph: null,
    statsScope: "view",           // périmètre des stats : vue courante | base entière
    statsGrain: "entites",        // onglet d'exploration : entites | paires | ensemble
    statsGraph: null,             // données /graph du périmètre stats courant
    lastSalience: null,           // dernier /salience (pour l'export texte)
    chartKind: null, chartUrl: null,   // aperçu de graphique courant
    statsSort: { col: null, dir: -1 },
    lastFocusBeforeStats: null,
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
   "deg-min", "deg-min-val", "open-filters", "filters-count",
   "filters-panel", "fp-reset", "fp-close", "fp-cols",
   "adv", "adv-toggle", "seg-link", "seg-pivot", "seg-color", "seg-labels",
   "size-by", "layout-sel", "axes-ctrl", "axis-x", "axis-y", "seg-axis-order",
   "force-ctrl", "force-linlog", "force-outbound", "force-community", "force-weight", "force-weight-val",
   "sim-ctrl", "sim-attract", "sim-opts", "sim-dims", "sim-threshold", "sim-threshold-val",
   "focus-bar", "focus-label", "focus-depth", "focus-depth-val", "focus-back", "focus-exit",
   "parcours-bar", "parcours-chain", "parcours-play", "parcours-back", "parcours-text", "parcours-clear",
   "display-mode", "rail-foot",
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
   "chrono-pivot", "chrono-color", "chrono-status", "chrono-scroll",
   "stats-btn", "stats-close", "stats-screen", "stats-scope", "stats-meta",
   "stats-traits", "stats-grain", "stats-table", "hasard-btn", "hasard-btn-stats",
   "exp-synth", "exp-tab-csv", "exp-tab-xlsx", "exp-bars", "exp-histo", "exp-matrix",
   "stats-chart-block", "chart-title", "chart-preview", "chart-dl-png", "chart-dl-svg", "chart-hide"
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
    // Le dropzone est un <label> englobant l'input : cliquer ouvre déjà le sélecteur
    // de fichier nativement. Pas de handler JS rappelant .click() (sinon DOUBLE ouverture).
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
    State.cardFieldsSel = null; State.appliedCards = null;
    showRoles();
    // Raccourci de validation : ?auto=1 construit directement avec les rôles suggérés.
    if (/[?&]auto=1/.test(location.search)) buildGraph();
  }

  // --------------------------------------------------------- écran des rôles
  const ROLE_LABELS = { node: "Nœud", edge: "Lien", attribute: "Masqué", ignore: "Ignoré" };
  let workingRoles = {};
  let workingCards = {};   // présence sur la carte par colonne (indépendant du rôle)

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
    workingRoles = {}; workingCards = {};
    const appliedC = State.appliedCards;
    State.profile.columns.forEach((c) => {
      workingRoles[c.name] = (applied && applied[c.name] != null) ? applied[c.name] : c.suggested_role;
      // Présence sur la carte (indépendante du rôle) : défaut = colonnes nœud + masqué.
      workingCards[c.name] = (appliedC && appliedC[c.name] != null)
        ? appliedC[c.name] : ["node", "attribute"].includes(workingRoles[c.name]);
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
    const roles = ["node", "edge", "ignore", "attribute"].map((r) =>
      `<span class="role ${r} ${workingRoles[col.name] === r ? "on" : ""}" data-role="${r}">${ROLE_LABELS[r]}</span>`).join("");
    tr.innerHTML = `
      <td><div class="col-name">${esc(col.name)}</div><div class="col-sample">${esc((col.samples || []).slice(0, 3).join(", "))}${col.dtype !== "text" ? " · " + col.dtype : ""}</div></td>
      <td class="uniq">${col.n_unique} / ${col.n_filled}<span class="bar"><i style="width:${pct}%"></i></span></td>
      <td><div class="roles">${roles}</div></td>
      <td class="card-cell" title="Afficher cette colonne sur la carte (indépendant du rôle)"><input type="checkbox" class="card-chk"></td>`;
    const chk = tr.querySelector(".card-chk");
    // La carte n'a de sens que pour nœud / masqué (le lien = titre de carte ; ignoré = absent).
    const refreshCard = () => {
      const cardable = ["node", "attribute"].includes(workingRoles[col.name]);
      chk.disabled = !cardable;
      chk.checked = cardable && !!workingCards[col.name];
      tr.querySelector(".card-cell").classList.toggle("disabled", !cardable);
    };
    chk.addEventListener("change", () => { workingCards[col.name] = chk.checked; });
    tr.querySelectorAll(".role").forEach((span) => span.addEventListener("click", () => {
      workingRoles[col.name] = span.dataset.role;
      tr.querySelectorAll(".role").forEach((s) => s.classList.toggle("on", s.dataset.role === span.dataset.role));
      refreshCard();
      updateRolesHint();
    }));
    refreshCard();
    return tr;
  }

  function updateRolesHint() {
    const by = { node: [], edge: [], attribute: [] };
    Object.entries(workingRoles).forEach(([k, v]) => { if (by[v]) by[v].push(k); });
    const j = (a) => a.map((x) => esc(x)).join(", ") || "—";
    el["roles-hint"].innerHTML =
      `Nœuds : <b class="n">${j(by.node)}</b> — reliés par <b class="e">${j(by.edge)}</b>. ` +
      `Masqués (dispo., non affichés) : <b class="a">${j(by.attribute)}</b>.<br>` +
      `Astuce : un « Masqué » est un type de nœud caché par défaut — ses valeurs sont dans la fiche (et sur la carte si coché), et s'affichent d'un clic dans « Couches visibles ».`;
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
      // Présence sur la carte : amorce la sélection des « Champs sur la carte »
      // (colonnes cochées « Carte » ET en rôle nœud/masqué). Reste ajustable en direct.
      State.appliedCards = { ...workingCards };
      State.cardFieldsSel = Object.keys(workingCards).filter(
        (c) => workingCards[c] && ["node", "attribute"].includes(workingRoles[c]));
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
    State.connectors = new Set();          // aucune lentille au départ (tout affiché)
    State.pivot = null;
    State.degreeMin = 0;                    // filtre remis à zéro pour un nouveau fichier
    if (el["deg-min"]) { el["deg-min"].value = 0; el["deg-min-val"].textContent = "0"; }
    State.fullYearMin = State.summary.year_min; State.fullYearMax = State.summary.year_max;
    State.yearMin = State.summary.year_min; State.yearMax = State.summary.year_max;
    State.layoutSig = null;

    if (!window.__netInit) {
      NetView.init({
        container: $("sigma"), cards: $("cards"), tooltip: $("tooltip"),
        statusEl: el["statusline"], timeAxis: el["time-axis"],
        axisDecorX: $("axdec-x"), axisDecorY: $("axdec-y"),
        onSelect: selectNode, onBackground: deselect, onEdgeHover: edgeHover, onEdgeClick: selectEdge,
        onNodeDoubleClick: (id) => enterFocus(id),
      });
      window.__netInit = true;
      window.addEventListener("resize", () => {
        NetView.resize();
        syncTopbarHeight();
        if (State.fullYearMin != null) { drawHistogram(); positionWindow(); }
      });
    }

    // Libellés dérivés du nom d'unité choisi à la configuration.
    el["hinge-label"].textContent = cap(unitP());
    el["hinge-layer"].title = `Afficher les ${unitP()} comme nœuds-charnières`;
    if (el["chrono-sub"]) el["chrono-sub"].textContent =
      `Une ligne par entité ; chaque point est un ${unitS()} placé dans le temps.`;
    NetView.setUnitLabels(unitS(), unitP());
    NetView.setPalette(State.summary.palette || {});   // pastilles de type sur les cartes
    // Le graphe vient d'être (re)construit → cartes invalidées. On (re)charge les cartes
    // une fois (charnières ET entités, désormais) : elles servent dès le zoom sur un
    // nœud, pas seulement quand la charnière est affichée.
    State.cardsLoaded = false;
    NetView.setCardData({});
    ensureCardData();

    buildPivotList();
    buildLayers();
    buildFilterPanel();
    buildAxisControls();
    buildSimControls();
    buildCardFields();
    buildTimeline();
    toggleTemporalUI(State.fullYearMin != null);
    syncTopbarHeight();   // barre figée → la fiche démarre dessous (Exporter reste cliquable)
    el["rail-foot"].textContent =
      `${State.summary.n_works} ${unitP()} · ${State.summary.n_nodes_total} entités`;
    refreshGraph();
  }

  // Champs affichés sur la carte d'une charnière : choisis dans la modale (case « Carte »
  // par colonne → State.cardFieldsSel). Purement de l'affichage — toutes les valeurs sont
  // déjà fournies par /cards ; on transmet juste au rendu la liste retenue.
  function buildCardFields() {
    const layers = State.summary.node_layers || [];
    const attrs = State.summary.attr_cols || [];
    const tc = State.summary.time_col;
    const fields = [...layers, ...attrs];
    if (tc && !fields.includes(tc)) fields.push(tc);
    // Sélection de la modale (filtrée aux colonnes encore présentes) ; à défaut, défaut
    // adaptatif = entités liées + année (fiche biblio).
    State.cardFields = State.cardFieldsSel != null
      ? State.cardFieldsSel.filter((f) => fields.includes(f))
      : [...layers, tc].filter(Boolean);
    NetView.setCardFields(State.cardFields);
  }

  // Hauteur réelle de la barre supérieure → la fiche (.detail) démarre dessous,
  // sinon elle recouvre le bouton Exporter (et son propre bouton de fermeture).
  function syncTopbarHeight() {
    const tb = document.querySelector(".topbar");
    if (tb && tb.offsetHeight) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px");
  }

  // ------------------------------------------------------------- pivot & couches
  // Types actuellement *affichés* (rôle nœud d'origine OU promus via la lentille),
  // dans l'ordre des colonnes. Le pivot se construit là-dessus, pas sur la liste
  // figée à la configuration → il suit les changements de couches à la volée.
  function shownNodeTypes() {
    return (State.summary.layer_cols || [])
      .map((L) => L.col)
      .filter((c) => State.layersOn.has(c));
  }

  function buildPivotList() {
    el["pivot-list"].innerHTML = "";
    const types = shownNodeTypes();
    // Si le pivot courant n'est plus affiché, on retombe proprement sur « aucun ».
    if (State.pivot && !types.includes(State.pivot)) State.pivot = null;
    const mk = (label, value) => {
      const b = document.createElement("button");
      b.innerHTML = `<span class="pin"></span>${esc(label)}`;
      b.classList.toggle("on", State.pivot === value);
      b.addEventListener("click", () => setPivot(value));
      return b;
    };
    el["pivot-list"].appendChild(mk("Aucun (force libre)", null));
    types.forEach((t) => el["pivot-list"].appendChild(mk(t, t)));
  }

  // Disposition « axes » : peuple les sélecteurs X/Y depuis les colonnes activables.
  // X : libre / temps / attribut ; Y : force / centralité / attribut. La colonne
  // temporelle reste accessible aussi via l'option dédiée « Temps ».
  function buildAxisControls() {
    const dims = (State.summary.layer_cols || []).filter((c) => c.activable);
    const fill = (sel, head) => {
      sel.innerHTML = "";
      head.forEach(([v, lbl]) => sel.add(new Option(lbl, v)));
      dims.forEach((c) => sel.add(new Option(c.col + (c.kind === "numeric" ? " (num.)" : ""), c.col)));
    };
    fill(el["axis-x"], [["free", "Libre (force)"], ["time", "Temps"]]);
    fill(el["axis-y"], [["force", "Force"], ["centrality", "Centralité"]]);
    // Restaure la sélection si elle existe encore, sinon retombe sur le défaut.
    el["axis-x"].value = State.axisX;
    if (!el["axis-x"].value) { State.axisX = "free"; el["axis-x"].value = "free"; }
    el["axis-y"].value = State.axisY;
    if (!el["axis-y"].value) { State.axisY = "force"; el["axis-y"].value = "force"; }
    el["axes-ctrl"].style.display = (State.layout === "axes") ? "" : "none";
  }

  // Traduit un choix d'axe (chaîne) en spécification pour le placeur de render.js.
  function axisSpec(val, axis) {
    if (val === "free" || (axis === "y" && val === "force")) return { kind: "free" };
    if (val === "time") return { kind: "time" };
    if (val === "centrality") return { kind: "centrality" };
    const L = (State.summary.layer_cols || []).find((c) => c.col === val);
    return { kind: "attr", dim: val, dimKind: L ? L.kind : "categorical", order: State.axisOrder };
  }

  // Récupère les agrégats /axes pour les seuls axes de type attribut (les autres —
  // libre, temps, centralité — se calculent côté rendu depuis les données du nœud).
  async function fetchAxisData(specX, specY) {
    const dims = [...new Set([specX, specY].filter((s) => s.kind === "attr").map((s) => s.dim))];
    if (!dims.length) return {};
    const p = new URLSearchParams({ session_id: State.sessionId, dims: dims.join(",") });
    if (State.yearMin != null) { p.set("year_min", State.yearMin); p.set("year_max", State.yearMax); }
    try {
      const r = await getJSON("/axes?" + p.toString());
      return r.values || {};
    } catch (e) { flash("Erreur axes : " + e.message); return {}; }
  }

  // Similarité (T4) : cases des attributs catégoriels pris en compte (débrayables —
  // pas de boîte noire). Toutes cochées par défaut.
  function buildSimControls() {
    const cats = (State.summary.layer_cols || []).filter((c) => c.activable && c.kind !== "numeric");
    State.simDims = cats.map((c) => c.col);
    el["sim-dims"].innerHTML = "";
    cats.forEach((c) => {
      const lab = document.createElement("label");
      lab.className = "chk";
      lab.innerHTML = `<input type="checkbox" checked> ${esc(c.col)}`;
      lab.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) { if (!State.simDims.includes(c.col)) State.simDims.push(c.col); }
        else { State.simDims = State.simDims.filter((d) => d !== c.col); }
        State.layoutSig = null; refreshGraph();
      });
      el["sim-dims"].appendChild(lab);
    });
    el["sim-opts"].style.display = State.simAttract ? "" : "none";
    el["sim-ctrl"].style.display = ["force", "temporal", "axes"].includes(State.layout) ? "" : "none";
  }

  // Récupère les arêtes latentes de similarité (vide si désactivé / aucun attribut).
  async function fetchSimilar() {
    if (!State.simAttract || !State.simDims.length) return [];
    const p = new URLSearchParams({ session_id: State.sessionId, dims: State.simDims.join(","),
                                    threshold: State.simThreshold });
    if (State.yearMin != null) { p.set("year_min", State.yearMin); p.set("year_max", State.yearMax); }
    try {
      const r = await getJSON("/similar?" + p.toString());
      return r.edges || [];
    } catch (e) { flash("Erreur similarité : " + e.message); return []; }
  }

  // Positions de la disposition « similarité (MDS) » : embedding par dissimilarité
  // d'attributs (toutes colonnes catégorielles), pour les types actuellement affichés.
  async function fetchMds() {
    const p = new URLSearchParams({ session_id: State.sessionId, layers: [...State.layersOn].join(",") });
    if (State.yearMin != null) { p.set("year_min", State.yearMin); p.set("year_max", State.yearMax); }
    try {
      const r = await getJSON("/mds?" + p.toString());
      return r.positions || {};
    } catch (e) { flash("Erreur MDS : " + e.message); return {}; }
  }

  function setPivot(value) {
    State.pivot = value;
    buildPivotList();                       // repeint selon les couches affichées
    refreshGraph({ pivotChanged: true });
  }

  // Chaque couche a 3 états (cliquer pour cycler), pour explorer SANS reconfigurer :
  //   affiché  → le type est un nœud visible
  //   relie    → invisible mais relie les nœuds visibles (la « lentille »)
  //   masqué   → exclu (ni vu, ni reliant)
  function layerState(t) {
    if (State.layersOn.has(t)) return "shown";
    if (State.connectors.has(t)) return "connector";
    return "off";          // « off », pas « hidden » (réservé par .hidden global)
  }
  function cycleLayer(t) {
    if (State.layersOn.has(t)) { State.layersOn.delete(t); State.connectors.add(t); }
    else if (State.connectors.has(t)) { State.connectors.delete(t); }
    else { State.layersOn.add(t); }
  }
  const LAYER_STATE_LABEL = { shown: "affiché", connector: "relie", off: "masqué" };

  // Panneau unifié : TOUTE colonne non-ignorée (titre, info, année comprises) cycle
  // affiché → relie → masqué. Le rôle d'origine donne juste l'état par défaut.
  function buildLayers() {
    el["layers-list"].innerHTML = "";
    (State.summary.layer_cols || []).forEach((L) => {
      const t = L.col;
      const row = document.createElement("div");
      if (!L.activable) {
        row.className = "layer3 disabled";
        row.innerHTML = `<span class="sw" style="background:#C9C3B6"></span>` +
          `<span class="nm">${esc(t)}</span><span class="st">trop de valeurs</span>` +
          `<span class="ct">${L.n_unique}</span>`;
        row.title = `« ${t} » a trop de valeurs distinctes pour être un nœud/connecteur`;
        el["layers-list"].appendChild(row);
        return;
      }
      const color = State.summary.palette[t] || "#8A857B";
      const paint = () => {
        const st = layerState(t);
        row.className = "layer3 " + st + (L.warn ? " warn" : "");
        row.innerHTML = `<span class="sw" style="background:${color}"></span>` +
          `<span class="nm">${esc(t)}</span>` +
          `<span class="st">${LAYER_STATE_LABEL[st]}</span>` +
          `<span class="ct">${State.summary.type_counts[t] || L.n_unique}</span>`;
      };
      row.title = L.warn
        ? "Quasi-unique : « affiché » donne des nœuds isolés. Clic : affiché → relie → masqué"
        : "Cliquer pour cycler : affiché → relie (lentille) → masqué";
      row.addEventListener("click", () => {
        cycleLayer(t); paint();
        buildPivotList();                   // la couche change → « organiser autour de » suit
        refreshGraph();
      });
      paint();
      el["layers-list"].appendChild(row);
    });
    el["hinge-layer"].classList.toggle("off", !State.showHinge);
    el["hinge-layer"].onclick = () => {
      State.showHinge = !State.showHinge;
      el["hinge-layer"].classList.toggle("off", !State.showHinge);
      if (State.showHinge) ensureCardData();   // 1re activation → charge les cartes
      refreshGraph();
    };
  }

  // ------------------------------------------------------ volet de filtres (facettes)
  // Toute colonne activable est filtrable. Les valeurs se chargent à la demande (quand
  // on déplie une colonne). Tout coché = pas de filtre ; un sous-ensemble strict ne garde
  // que les objets reliés à une valeur cochée (OR dans la colonne, ET entre colonnes).
  function buildFilterPanel() {
    State.filterCols = (State.summary && State.summary.filter_cols) || [];
    State.facetValues = {}; State.facetCounts = {}; State.facetSort = {};
    State.facetTrunc = {}; State.facets = {};
    el["fp-cols"].innerHTML = "";
    State.filterCols.forEach((c) => el["fp-cols"].appendChild(makeFacetGroup(c)));
    updateFilterCount();
  }

  // Un groupe repliable par colonne. Les valeurs (cases) ne se chargent qu'au 1er dépli.
  function makeFacetGroup(c) {
    const col = c.col;
    const det = document.createElement("details");
    det.className = "facet-group";
    det.innerHTML =
      `<summary><span class="fg-name">${esc(col)}</span>` +
      `<span class="fg-meta">${c.n_unique}${c.is_time ? " · temps" : ""}</span>` +
      `<span class="fg-count" data-col="${esc(col)}"></span></summary>` +
      `<div class="fg-load">…</div>`;
    det.addEventListener("toggle", () => {
      if (det.open && !State.facetValues[col]) loadFacetValues(col, det);
    }, { once: false });
    return det;
  }

  async function loadFacetValues(col, det) {
    const body = det.querySelector(".fg-load");
    try {
      const r = await getJSON(`/facet-values?session_id=${encodeURIComponent(State.sessionId)}&col=${encodeURIComponent(col)}`);
      const items = r.values || [];                 // [{value, count}]
      State.facetValues[col] = items.map((it) => it.value);
      State.facetCounts[col] = {};
      items.forEach((it) => { State.facetCounts[col][it.value] = it.count; });
      State.facetTrunc[col] = !!r.truncated;
      if (!State.facetSort[col]) State.facetSort[col] = "alpha";
      if (!State.facets[col]) State.facets[col] = new Set(State.facetValues[col]);  // tout coché
      renderFacetValues(col, det, body);
    } catch (e) { body.textContent = "Erreur : " + e.message; }
  }

  function renderFacetValues(col, det, container) {
    const values = State.facetValues[col];
    container.className = "fg-content";
    container.innerHTML =
      `<div class="fg-tools">` +
      (values.length > 8 ? `<input class="fg-search" placeholder="Rechercher…">` : "") +
      `<button class="fg-all" type="button">Tout</button>` +
      `<button class="fg-none" type="button">Aucun</button>` +
      `<select class="fg-sort" title="Trier les valeurs"><option value="alpha">A→Z</option><option value="count">Nb&nbsp;↓</option></select>` +
      `</div>` +
      (State.facetTrunc[col] ? `<div class="fg-trunc">${values.length} valeurs les plus fréquentes — affine par la recherche.</div>` : "") +
      `<div class="facet-values"></div>`;
    const box = container.querySelector(".facet-values");
    fillFacetValueList(col, det, box);
    const sortSel = container.querySelector(".fg-sort");
    sortSel.value = State.facetSort[col] || "alpha";
    sortSel.addEventListener("change", () => {
      State.facetSort[col] = sortSel.value;
      fillFacetValueList(col, det, box);
      applyFacetSearch(container, box);
    });
    const search = container.querySelector(".fg-search");
    if (search) search.addEventListener("input", () => applyFacetSearch(container, box));
    container.querySelector(".fg-all").addEventListener("click", () => setFacetAll(col, det, true));
    container.querySelector(".fg-none").addEventListener("click", () => setFacetAll(col, det, false));
    updateFacetGroupCount(col, det);
  }

  // (Re)construit la liste de cases dans l'ordre de tri courant (alpha / occurrences).
  function fillFacetValueList(col, det, box) {
    const counts = State.facetCounts[col] || {};
    const checked = State.facets[col];
    const order = [...State.facetValues[col]];
    if ((State.facetSort[col] || "alpha") === "count")
      order.sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
    else
      order.sort((a, b) => a.localeCompare(b));
    box.innerHTML = "";
    order.forEach((v) => {
      const lab = document.createElement("label");
      lab.className = "chk"; lab.dataset.v = v.toLowerCase();
      const inp = document.createElement("input");
      inp.type = "checkbox"; inp.checked = checked.has(v);
      inp.addEventListener("change", () => {
        if (inp.checked) checked.add(v); else checked.delete(v);
        onFacetChange(col, det);
      });
      const name = document.createElement("span");
      name.className = "fg-vlabel"; name.textContent = v;
      const cnt = document.createElement("span");
      cnt.className = "fg-vcount"; cnt.textContent = counts[v] != null ? counts[v] : "";
      lab.append(inp, name, cnt);
      box.appendChild(lab);
    });
  }

  function applyFacetSearch(container, box) {
    const search = container.querySelector(".fg-search");
    const q = search ? search.value.trim().toLowerCase() : "";
    box.querySelectorAll("label").forEach((l) => {
      l.style.display = (!q || l.dataset.v.includes(q)) ? "" : "none";
    });
  }

  function setFacetAll(col, det, on) {
    // Muter le MÊME Set (ne pas le remplacer) : les cases individuelles gardent une
    // référence vers lui. Le remplacer les « orphelinerait » → leurs clics ne
    // toucheraient plus l'état lu par la requête (la vue ne bougerait plus).
    const checked = State.facets[col];
    checked.clear();
    if (on) State.facetValues[col].forEach((v) => checked.add(v));
    det.querySelectorAll(".facet-values input").forEach((inp) => { inp.checked = on; });
    onFacetChange(col, det);
  }

  // Mise à jour LIVE de la carte (pas de bouton « Appliquer »), avec anti-rebond pour
  // coalescer les clics rapides — la carte reste visible (volet non-modal) et se recompose.
  let filterRefreshTimer = null;
  function scheduleFilterRefresh() {
    clearTimeout(filterRefreshTimer);
    filterRefreshTimer = setTimeout(() => refreshGraph(), 180);
  }
  function onFacetChange(col, det) {
    updateFacetGroupCount(col, det);
    updateFilterCount();
    scheduleFilterRefresh();
  }

  // Une colonne « filtre activement » dès qu'elle n'est PAS entièrement cochée (y compris
  // tout décoché → rien gardé). Tout coché = pas de contrainte.
  function facetIsActive(col) {
    const vals = State.facetValues[col]; const checked = State.facets[col];
    return !!(vals && checked && checked.size < vals.length);
  }
  function updateFacetGroupCount(col, det) {
    const badge = det.querySelector(".fg-count");
    const vals = State.facetValues[col] || [];
    badge.textContent = facetIsActive(col) ? `${State.facets[col].size}/${vals.length}` : "";
  }
  function activeFacetCount() {
    return Object.keys(State.facets).filter(facetIsActive).length;
  }
  function updateFilterCount() {
    const n = activeFacetCount();
    el["filters-count"].textContent = n ? String(n) : "";
    el["filters-count"].classList.toggle("on", n > 0);
  }

  function filtersOpen() { return el["filters-panel"].classList.contains("open"); }
  function toggleFilters() { filtersOpen() ? closeFilters() : openFilters(); }
  function openFilters() {
    el["filters-panel"].classList.add("open");
    el["filters-panel"].setAttribute("aria-hidden", "false");
  }
  function closeFilters() {
    el["filters-panel"].classList.remove("open");
    el["filters-panel"].setAttribute("aria-hidden", "true");
  }
  function resetFilters() {
    // Recoche tout partout (en MUTANT les Set existants, cf. setFacetAll) → plus aucun filtre.
    Object.keys(State.facets).forEach((col) => {
      const checked = State.facets[col];
      checked.clear();
      (State.facetValues[col] || []).forEach((v) => checked.add(v));
    });
    el["fp-cols"].querySelectorAll("details.facet-group").forEach((det) => {
      det.querySelectorAll(".facet-values input").forEach((inp) => { inp.checked = true; });
      const col = det.querySelector(".fg-count")?.dataset.col;
      if (col) updateFacetGroupCount(col, det);
    });
    updateFilterCount();
    scheduleFilterRefresh();
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
    el["layout-sel"].addEventListener("change", (e) => {
      State.layout = e.target.value; State.layoutSig = null;
      el["axes-ctrl"].style.display = (State.layout === "axes") ? "" : "none";
      // Les réglages de force ne concernent que les dispositions à base de force.
      const forceBased = ["force", "temporal", "axes"].includes(State.layout);
      el["force-ctrl"].style.display = forceBased ? "" : "none";
      el["sim-ctrl"].style.display = forceBased ? "" : "none";
      refreshGraph();
    });
    el["axis-x"].addEventListener("change", (e) => { State.axisX = e.target.value; State.layoutSig = null; refreshGraph(); });
    el["axis-y"].addEventListener("change", (e) => { State.axisY = e.target.value; State.layoutSig = null; refreshGraph(); });
    wireSeg(el["seg-axis-order"], (v) => { State.axisOrder = v; State.layoutSig = null; refreshGraph(); });
    // Réglages de force (T3) : chaque changement relance la disposition.
    const forceToggle = (key, id) => el[id].addEventListener("change", (e) => {
      State.force = { ...State.force, [key]: e.target.checked }; State.layoutSig = null; refreshGraph();
    });
    forceToggle("linLog", "force-linlog");
    forceToggle("outbound", "force-outbound");
    forceToggle("groupByCommunity", "force-community");
    // input → maj du libellé seulement (léger) ; change (au relâcher) → relayout,
    // pour éviter de relancer ForceAtlas2 à chaque cran pendant le glissement.
    el["force-weight"].addEventListener("input", (e) => {
      el["force-weight-val"].textContent = e.target.value;
    });
    el["force-weight"].addEventListener("change", (e) => {
      State.force = { ...State.force, edgeWeight: +e.target.value };
      State.layoutSig = null; refreshGraph();
    });
    el["sim-attract"].addEventListener("change", (e) => {
      State.simAttract = e.target.checked;
      el["sim-opts"].style.display = State.simAttract ? "" : "none";
      State.layoutSig = null; refreshGraph();
    });
    // Seuil : libellé en direct (input), relayout au relâcher (change) — comme l'influence.
    el["sim-threshold"].addEventListener("input", (e) => {
      el["sim-threshold-val"].textContent = (+e.target.value).toFixed(2);
    });
    el["sim-threshold"].addEventListener("change", (e) => {
      State.simThreshold = +e.target.value; State.layoutSig = null; refreshGraph();
    });
    // Focalisation (ego) : profondeur, retour, sortie.
    el["focus-depth"].addEventListener("input", (e) => { el["focus-depth-val"].textContent = e.target.value; });
    el["focus-depth"].addEventListener("change", (e) => {
      State.focusHops = +e.target.value; State.layoutSig = null;
      if (State.focus) refreshGraph().then(() => NetView.centerOnNodes([State.focus]));
    });
    el["focus-back"].addEventListener("click", focusBack);
    el["focus-exit"].addEventListener("click", exitFocus);
    el["parcours-play"].addEventListener("click", parcoursPlay);
    el["parcours-back"].addEventListener("click", parcoursBack);
    el["parcours-text"].addEventListener("click", parcoursText);
    el["parcours-clear"].addEventListener("click", deselect);
    // Filtre « degré minimum » : libellé en direct (input), application au relâcher (change).
    // Pas de relayout : les positions restent stables, on masque seulement les nœuds peu reliés.
    el["deg-min"].addEventListener("input", (e) => { el["deg-min-val"].textContent = e.target.value; });
    el["deg-min"].addEventListener("change", (e) => { State.degreeMin = +e.target.value; refreshGraph(); });
    // Volet de filtres (toute colonne) — non-modal : la carte reste active à côté.
    el["open-filters"].addEventListener("click", toggleFilters);
    el["fp-close"].addEventListener("click", closeFilters);
    el["fp-reset"].addEventListener("click", resetFilters);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && filtersOpen()) closeFilters(); });
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
    initStats();
  }

  // ---------------------------------------------------------- rafraîchir la carte
  function queryString() {
    const p = new URLSearchParams();
    p.set("session_id", State.sessionId);
    p.set("layers", [...State.layersOn].join(","));
    // Toujours envoyé (même vide) → sémantique « lentille » : seules ces couches
    // relient ; les couches masquées non-connectrices sont exclues.
    p.set("connectors", [...State.connectors].join(","));
    p.set("link_mode", State.linkMode);
    p.set("show_hinge", State.showHinge);
    p.set("color_by", State.colorBy);
    p.set("size_by", State.sizeBy);
    if (State.pivot) p.set("pivot", State.pivot);
    if (State.yearMin != null) { p.set("year_min", State.yearMin); p.set("year_max", State.yearMax); }
    if (State.focus) { p.set("focus", State.focus); p.set("hops", State.focusHops); }   // focalisation (ego)
    if (State.degreeMin > 0) p.set("degree_min", State.degreeMin);                       // filtre degré min
    // Facettes : on n'envoie une colonne que si elle n'est pas entièrement cochée
    // (liste possiblement vide = tout décoché = rien gardé). Tout coché = pas de filtre.
    const facetObj = {};
    Object.keys(State.facets || {}).forEach((col) => {
      if (facetIsActive(col)) facetObj[col] = [...State.facets[col]];
    });
    if (Object.keys(facetObj).length) p.set("facets", JSON.stringify(facetObj));
    return p.toString();
  }
  function layoutSignature() {
    return JSON.stringify({
      l: [...State.layersOn].sort(), link: State.linkMode, hinge: State.showHinge,
      lay: State.layout, piv: State.pivotMode === "reorganize" ? State.pivot : null,
      ax: State.layout === "axes" ? [State.axisX, State.axisY, State.axisOrder] : null,
      f: State.force,
      sim: State.simAttract ? { t: State.simThreshold, d: State.simDims.slice().sort() } : null,
      fo: State.focus, fh: State.focus ? State.focusHops : null,
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
      // Focalisation : le nœud focal est hors de la vue (filtres/années) → le backend
      // a ignoré le focus et renvoyé la vue complète ; on lève la focalisation proprement.
      if (data.focus_dropped && State.focus) {
        State.focus = null; State.focusTrail = []; updateFocusBar();
        flash("Nœud focal hors de la vue (filtres / années) — focalisation levée.");
      }
      const sig = layoutSignature();
      const relayout = sig !== State.layoutSig;
      // Disposition « axes » : on résout les specs X/Y et, au relayout, on récupère
      // les agrégats d'attribut nécessaires (brique T1, /axes).
      let axisX = null, axisY = null, axisData = null;
      if (State.layout === "axes") {
        axisX = axisSpec(State.axisX, "x");
        axisY = axisSpec(State.axisY, "y");
        if (relayout) axisData = await fetchAxisData(axisX, axisY);
      }
      // Similarité (T4) : arêtes latentes récupérées au relayout, injectées dans FA2.
      const latentEdges = (relayout && State.simAttract) ? await fetchSimilar() : null;
      // Similarité MDS (T5) : positions de l'embedding récupérées au relayout.
      const mdsPositions = (relayout && State.layout === "mds") ? await fetchMds() : null;
      NetView.render(data, {
        relayout, layoutKind: State.layout,
        axisX, axisY, axisData, force: State.force, latentEdges, mdsPositions,
        pivot: State.pivot, pivotMode: State.pivotMode,
        yearMin: State.fullYearMin, yearMax: State.fullYearMax,
      });
      State.layoutSig = sig;
      NetView.setLabelsDensity(State.labels);
      updateEpochLegend(data.epoch_legend);
      if (State.focus) updateFocusBar();      // libellé/retour à jour avec l'ego courant
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
      maybeSyncStats();    // stats ouvertes en « vue courante » → suivent les filtres
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
  async function selectNode(id, opts) {
    opts = opts || {};
    stopParcoursPlay();                            // toute interaction interrompt le « rejouer »
    if (State.focus) { enterFocus(id); return; }   // en focalisation : clic = re-focalise
    State.selected = id;
    // Parcours : un clic sur un VOISIN (dans la projection) continue la chaîne ; un clic
    // ailleurs démarre un nouveau parcours. Un saut explicite (fiche) continue toujours.
    const head = State.parcours[State.parcours.length - 1];
    const continues = opts.fromParcours
      || (head && head !== id && !State.parcours.includes(id)
          && projectedNeighbors(head).some((n) => n.id === id));
    if (continues) State.parcours.push(id);
    else State.parcours = [id];
    highlightParcours();
    updateParcoursBar();
    showDetail(id);
  }

  // Voisins du nœud DANS la projection courante (les seuls sauts proposés).
  function projectedNeighbors(id) {
    const g = State.lastGraph;
    if (!g) return [];
    const ids = new Set();
    g.edges.forEach((e) => { if (e.source === id) ids.add(e.target); else if (e.target === id) ids.add(e.source); });
    return g.nodes.filter((n) => ids.has(n.id));
  }
  function highlightParcours() {
    if (State.parcours.length >= 2) NetView.setPath(State.parcours);
    else NetView.setHighlight(State.parcours[0] || null);
  }

  async function showDetail(id) {
    try {
      let url = `/node/${encodeURIComponent(id)}?session_id=${State.sessionId}`;
      if (State.yearMin != null) url += `&year_min=${State.yearMin}&year_max=${State.yearMax}`;
      renderDetail(await getJSON(url));
    } catch (e) { flash("Détail indisponible : " + e.message); }
  }

  function deselect() {
    stopParcoursPlay();
    if (State.focus) { exitFocus(); return; }      // clic sur le fond en focalisation → on sort
    State.selected = null;
    State.parcours = [];
    NetView.setHighlight(null);
    el["detail"].classList.remove("open");
    updateParcoursBar();
  }

  // -------------------------------------------------------------- parcours (T4)
  function labelOf(id) {
    const n = (State.lastGraph && State.lastGraph.nodes || []).find((x) => x.id === id);
    return n ? n.label : id;
  }
  // Saut explicite depuis la fiche (voisin de la projection) : continue la chaîne.
  function parcoursJump(id) { selectNode(id, { fromParcours: true }); NetView.centerOnNodes([id]); }

  // Parcours AU HASARD (T5 complet) : marche aléatoire depuis `startId`, saut après saut
  // vers un voisin non encore visité (jusqu'à ~6 pas ou impasse), puis on rejoue le chemin.
  const RW_STEPS = 6;
  function randomWalkFrom(startId) {
    const chain = [startId];
    for (let i = 0; i < RW_STEPS; i++) {
      const head = chain[chain.length - 1];
      const neigh = projectedNeighbors(head).filter((n) => !chain.includes(n.id));
      if (!neigh.length) break;
      chain.push(neigh[Math.floor(Math.random() * neigh.length)].id);
    }
    if (chain.length < 2) { flash("Pas de voisin pour cheminer au hasard."); return; }
    stopParcoursPlay();
    State.parcours = chain; State.selected = chain[chain.length - 1];
    highlightParcours(); updateParcoursBar();
    parcoursPlay();                       // révèle le chemin inattendu pas à pas
  }
  function parcoursBack() {
    if (State.parcours.length <= 1) { deselect(); return; }
    State.parcours.pop();
    goToHead();
  }
  function parcoursGoto(idx) {                       // clic sur un maillon → tronque jusqu'à lui
    if (idx < 0 || idx >= State.parcours.length) return;
    State.parcours = State.parcours.slice(0, idx + 1);
    goToHead();
  }
  function goToHead() {
    stopParcoursPlay();
    const head = State.parcours[State.parcours.length - 1];
    State.selected = head;
    highlightParcours(); updateParcoursBar(); showDetail(head); NetView.centerOnNodes([head]);
  }

  function updateParcoursBar() {
    const chain = State.parcours;
    if (chain.length < 2) { el["parcours-bar"].classList.add("hidden"); return; }
    el["parcours-bar"].classList.remove("hidden");
    const host = el["parcours-chain"]; host.innerHTML = "";
    chain.forEach((id, i) => {
      if (i > 0) {
        const arr = document.createElement("span");
        arr.className = "pb-arrow"; arr.textContent = "→"; arr.title = "(survol : pourquoi reliés)";
        arr.addEventListener("mouseenter", () => explainChainon(chain[i - 1], id, arr), { once: true });
        host.appendChild(arr);
      }
      const chip = document.createElement("span");
      chip.className = "pb-node" + (i === chain.length - 1 ? " head" : "");
      chip.textContent = labelOf(id); chip.title = labelOf(id);
      chip.addEventListener("click", () => parcoursGoto(i));
      host.appendChild(chip);
    });
    host.scrollLeft = host.scrollWidth;              // suit la tête
  }

  async function edgeExplain(a, b) {
    const p = new URLSearchParams({ session_id: State.sessionId, source: a, target: b });
    if (State.yearMin != null) { p.set("year_min", State.yearMin); p.set("year_max", State.yearMax); }
    const d = await getJSON("/edge?" + p.toString());
    // L'ouvrage commun est la raison directe ; sinon (lien indirect) on cite les
    // intermédiaires partagés, limités pour rester lisible.
    const works = (d.shared_works || []).map((w) => (w && w.label) || w);
    if (works.length) return `${cap(unitP())} communs : ${works.slice(0, 4).join(" · ")}`;
    const via = Object.entries(d.shared_via || {}).slice(0, 3).map(([t, arr]) => `${t} : ${arr.join(", ")}`);
    return via.length ? "Reliés via " + via.join(" ; ") : "Reliés dans la vue courante.";
  }
  async function explainChainon(a, b, arrEl) {
    try { arrEl.title = await edgeExplain(a, b); }
    catch (e) { arrEl.title = "Explication indisponible."; }
  }

  // Export texte du parcours : la chaîne factuelle (l'analyste l'interprète).
  async function parcoursText() {
    const chain = State.parcours;
    if (chain.length < 2) return;
    const lines = ["Parcours", "========", chain.map(labelOf).join("  →  "), ""];
    for (let i = 0; i + 1 < chain.length; i++) {
      let detail = "reliés dans la vue courante";
      try { detail = (await edgeExplain(chain[i], chain[i + 1])).replace(/\n/g, " — "); } catch (e) {}
      lines.push(`- ${labelOf(chain[i])} → ${labelOf(chain[i + 1])} : ${detail}`);
    }
    downloadBlob(new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" }), "parcours.txt");
  }

  // « Rejouer » : redessine la chaîne pas à pas (centre + surligne chaque maillon),
  // puis ouvre la fiche d'arrivée. Toute interaction (clic) l'interrompt.
  function stopParcoursPlay() {
    State.parcoursPlaying = false;
    if (el["parcours-play"]) el["parcours-play"].textContent = "▶";
  }
  function markPlayStep(i) {
    el["parcours-chain"].querySelectorAll(".pb-node")
      .forEach((c, k) => c.classList.toggle("head", k === i));
  }
  async function parcoursPlay() {
    if (State.parcoursPlaying) { stopParcoursPlay(); return; }
    const chain = State.parcours.slice();
    if (chain.length < 2) return;
    State.parcoursPlaying = true;
    el["parcours-play"].textContent = "⏸";
    for (let i = 0; i < chain.length; i++) {
      if (!State.parcoursPlaying) break;
      NetView.setPath(chain.slice(0, i + 1));
      NetView.centerOnNodes([chain[i]]);
      markPlayStep(i);
      await sleep(1000);
    }
    const wasPlaying = State.parcoursPlaying;
    stopParcoursPlay();
    if (wasPlaying && State.parcours.length) {          // arrivé au bout sans interruption
      highlightParcours(); markPlayStep(State.parcours.length - 1);
      showDetail(State.parcours[State.parcours.length - 1]);
    }
  }

  // ----------------------------------------------------------- focalisation (ego)
  // Cliquer/double-cliquer un nœud le pose comme centre : la vue se restreint à son
  // voisinage (sous-graphe ego), recentrée ; tous les réglages opèrent dessus. On
  // navigue de proche en proche (clic d'un voisin re-focalise), avec un fil retour.
  async function enterFocus(id) {
    if (State.focus && State.focus !== id) State.focusTrail.push(State.focus);
    State.focus = id; State.selected = id;
    State.parcours = []; updateParcoursBar();       // focalisation et parcours = modes distincts
    State.layoutSig = null;
    NetView.setHighlight(null);          // l'ego EST le périmètre → aucun estompage
    updateFocusBar();
    await refreshGraph();
    if (State.focus === id) { NetView.centerOnNodes([id]); showDetail(id); }   // si pas levé
  }
  async function focusBack() {
    State.focus = State.focusTrail.length ? State.focusTrail.pop() : null;
    State.selected = State.focus;
    State.layoutSig = null;
    NetView.setHighlight(null);
    updateFocusBar();
    await refreshGraph();
    if (State.focus) { NetView.centerOnNodes([State.focus]); showDetail(State.focus); }
  }
  function exitFocus() {
    State.focus = null; State.focusTrail = []; State.selected = null;
    State.layoutSig = null; updateFocusBar();
    NetView.setHighlight(null);
    el["detail"].classList.remove("open");
    refreshGraph();
  }
  function updateFocusBar() {
    const on = !!State.focus;
    el["focus-bar"].classList.toggle("hidden", !on);
    if (!on) return;
    const node = ((State.lastGraph && State.lastGraph.nodes) || []).find((n) => n.id === State.focus);
    el["focus-label"].textContent = node ? node.label : String(State.focus).split("::").pop();
    el["focus-depth"].value = State.focusHops;
    el["focus-depth-val"].textContent = State.focusHops;
    el["focus-back"].style.display = State.focusTrail.length ? "" : "none";
  }

  // Clic sur une arête → volet « pourquoi ce lien » (ouvrages communs + intermédiaires
  // partagés), persistant, en plus de l'info-bulle de survol. On isole la paire.
  async function selectEdge(s, t) {
    State.selected = null;                 // sélection d'arête, pas de nœud
    NetView.setFocus([s, t]);
    NetView.centerOnNodes([s, t]);
    try {
      let url = `/edge?session_id=${State.sessionId}&source=${encodeURIComponent(s)}&target=${encodeURIComponent(t)}`;
      if (State.yearMin != null) url += `&year_min=${State.yearMin}&year_max=${State.yearMax}`;
      renderEdgeDetail(await getJSON(url));
    } catch (e) { flash("Détail du lien indisponible : " + e.message); }
  }

  function renderEdgeDetail(d) {
    el["dhead"].style.background = "#B8453F";       // rouge sélection : c'est un lien
    el["d-title"].textContent = `${d.source_label} ↔ ${d.target_label}`;
    el["d-sub"].textContent = "Pourquoi ce lien";
    let html = "";
    const works = d.shared_works || [];
    const via = Object.entries(d.shared_via || {});
    if (works.length) {
      html += `<div class="k" style="font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:bold;margin:2px 0 8px">${esc(cap(unitP()))} en commun</div>`;
      works.forEach((w) => {
        html += `<div class="work"><div class="t">${esc(w.label)}</div><div class="s">${w.year != null ? w.year : ""}</div></div>`;
      });
    }
    via.forEach(([type, arr]) => {
      html += `<div class="stat"><div class="k">via ${esc(type)}</div><div class="v">${arr.slice(0, 12).map((x) => `<span class="dtag">${esc(x)}</span>`).join("")}</div></div>`;
    });
    if (!works.length && !via.length) html += stat("Lien", "indirect (plusieurs intermédiaires)");
    el["dbody"].innerHTML = html;
    el["detail"].classList.add("open");
  }

  // Survol d'une arête → on demande au backend POURQUOI les deux nœuds sont reliés
  // (ouvrages communs + intermédiaires partagés), et on l'affiche en info-bulle.
  let edgeTipT = null;
  function edgeHover(s, t, show) {
    clearTimeout(edgeTipT);
    edgeTipT = setTimeout(async () => {
      try {
        let url = `/edge?session_id=${State.sessionId}&source=${encodeURIComponent(s)}&target=${encodeURIComponent(t)}`;
        if (State.yearMin != null) url += `&year_min=${State.yearMin}&year_max=${State.yearMax}`;
        show(formatEdge(await getJSON(url)));
      } catch (e) { /* survol fugace : on ignore */ }
    }, 70);
  }
  function formatEdge(d) {
    let html = `${esc(d.source_label)} ↔ ${esc(d.target_label)}`;
    const works = d.shared_works || [];
    const via = Object.entries(d.shared_via || {}).map(([t, arr]) => `${esc(t)} : ${esc(arr.join(", "))}`);
    if (works.length)
      html += `<div class="t2">${unitN(works.length)} en commun : ${esc(works.map((w) => w.label).join(" · "))}</div>`;
    if (via.length) html += `<div class="t2">via ${via.join(" · ")}</div>`;
    if (!works.length && !via.length) html += `<div class="t2">lien indirect (plusieurs intermédiaires)</div>`;
    return html;
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
    // Parcours : voisins du nœud DANS la projection courante = les sauts possibles.
    // Hors focalisation (là, cliquer un voisin re-focalise au lieu de cheminer).
    let cont = "";
    if (!State.focus) {
      const neigh = projectedNeighbors(d.id).filter((n) => !State.parcours.includes(n.id));
      if (neigh.length) {
        cont = `<div class="cont-head"><span class="cont-lab">Continuer le parcours →</span>` +
          `<button class="rw-btn" type="button" title="Marche aléatoire de quelques pas à partir d'ici">🔀 au hasard</button></div>` +
          `<div class="cont-chips">` +
          neigh.slice(0, 40).map((n) =>
            `<span class="cont-chip" data-id="${esc(n.id)}" style="--c:${n.color || "#8A857B"}">${esc(n.label)}</span>`).join("") +
          (neigh.length > 40 ? `<span class="cont-more">+${neigh.length - 40}</span>` : "") +
          `</div>`;
      }
    }
    const focusing = State.focus === d.id;
    html = `<button class="focus-btn">${focusing ? "✕ Quitter la focalisation" : "🎯 Focaliser sur ce nœud"}</button>` + cont + html;
    el["dbody"].innerHTML = html;
    const fb = el["dbody"].querySelector(".focus-btn");
    if (fb) fb.addEventListener("click", () => (focusing ? exitFocus() : enterFocus(d.id)));
    el["dbody"].querySelectorAll(".cont-chip").forEach((c) =>
      c.addEventListener("click", () => parcoursJump(c.dataset.id)));
    const rw = el["dbody"].querySelector(".rw-btn");
    if (rw) rw.addEventListener("click", () => randomWalkFrom(d.id));
    el["detail"].classList.add("open");
  }
  function stat(k, v) { return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`; }

  // =============================================================== STATISTIQUES (T3)
  // Périmètre : "view" reprend les filtres de la carte ; "base" les ignore (recensement).
  function statsQuery(scope) {
    const p = new URLSearchParams();
    p.set("session_id", State.sessionId);
    p.set("layers", [...State.layersOn].join(","));
    p.set("connectors", [...State.connectors].join(","));
    p.set("link_mode", State.linkMode);
    p.set("show_hinge", State.showHinge);
    p.set("size_by", State.sizeBy);
    if (State.pivot) p.set("pivot", State.pivot);
    if (scope === "view") {                          // base = on ignore les filtres
      if (State.yearMin != null) { p.set("year_min", State.yearMin); p.set("year_max", State.yearMax); }
      if (State.focus) { p.set("focus", State.focus); p.set("hops", State.focusHops); }
      if (State.degreeMin > 0) p.set("degree_min", State.degreeMin);
      const facetObj = {};
      Object.keys(State.facets || {}).forEach((c) => { if (facetIsActive(c)) facetObj[c] = [...State.facets[c]]; });
      if (Object.keys(facetObj).length) p.set("facets", JSON.stringify(facetObj));
    }
    return p.toString();
  }

  function statsOpen() { return !el["stats-screen"].classList.contains("hidden"); }
  function openStats() {
    el["stats-screen"].classList.remove("hidden");
    el["stats-screen"].setAttribute("aria-hidden", "false");
    loadStats();
  }
  function closeStats() {
    el["stats-screen"].classList.add("hidden");
    el["stats-screen"].setAttribute("aria-hidden", "true");
  }

  async function loadStats() {
    const scope = State.statsScope;
    const q = statsQuery(scope);
    el["stats-traits"].innerHTML = `<div class="stats-empty">Calcul…</div>`;
    el["stats-table"].innerHTML = "";
    hideChart();                                 // aperçu de graphique périmé → on le masque
    try {
      const [sal, gdata] = await Promise.all([
        getJSON(`/salience?${q}&scope=${scope}`),
        getJSON(`/graph?${q}`),
      ]);
      State.statsGraph = gdata;
      State.lastSalience = sal;
      const s = gdata.summary;
      el["stats-meta"].textContent =
        `${s.n_nodes} nœuds · ${s.n_edges} liens · ${s.n_communities} communautés`;
      renderTraits(sal);
      renderStatsTable();
    } catch (e) {
      el["stats-traits"].innerHTML = `<div class="stats-empty">Erreur : ${esc(e.message)}</div>`;
    }
  }

  const KIND_LABEL = {
    prolifique: "Se détachent", passeur: "Passeurs (relient des mondes)",
    paire: "Paires récurrentes", pont: "Ponts uniques", communaute: "Communautés",
    temps: "Temps", anomalie: "Anomalies",
  };
  // Ordre éditorial : les catégories les plus parlantes d'abord, les notes de bas après.
  const KIND_ORDER = ["prolifique", "paire", "passeur", "communaute", "temps", "pont", "anomalie"];
  // Met en évidence ce qui est saillant : entités entre guillemets + écarts chiffrés.
  function emphasize(text) {
    return esc(text)
      .replace(/«\s*([^»]+?)\s*»/g, "« <b>$1</b> »")
      .replace(/(\d+(?:[.,]\d+)?×)/g, "<b>$1</b>");
  }

  const SHOWN_PER_GROUP = 3;

  // Une ligne « item » d'un trait (texte mis en évidence + lien vers la carte).
  function traitRow(t, extraClass) {
    const row = document.createElement("div");
    row.className = "trait-row" + (extraClass || "");
    row.innerHTML = `<span class="tr-text">${emphasize(t.detail)}</span>`;
    if (t.refs && t.refs.length) {
      const b = document.createElement("button");
      b.className = "t-see"; b.textContent = "→ carte";
      b.addEventListener("click", () => seeOnMap(t.refs));
      row.appendChild(b);
    }
    return row;
  }

  function renderTraits(sal) {
    const traits = (sal && sal.traits) || [];
    el["stats-traits"].innerHTML = "";
    if (!traits.length) {
      el["stats-traits"].innerHTML = `<div class="stats-empty">Rien de saillant dans ce périmètre.</div>`;
      return;
    }
    // Une carte par CATÉGORIE (ordre éditorial), items triés, 3 visibles + « voir plus ».
    // Pas de « à retenir » ni de mise en avant : l'outil pose les faits, pas la conclusion.
    const byKind = {};
    traits.forEach((t) => { (byKind[t.kind] = byKind[t.kind] || []).push(t); });
    const kinds = KIND_ORDER.filter((k) => byKind[k] && byKind[k].length)
      .concat(Object.keys(byKind).filter((k) => !KIND_ORDER.includes(k) && byKind[k].length));
    kinds.forEach((kind) => {
      const items = byKind[kind];
      const group = document.createElement("div");
      group.className = "trait-group";
      group.innerHTML = `<div class="tg-head">${esc(KIND_LABEL[kind] || kind)}` +
        `<span class="tg-count">${items.length}</span></div>`;
      items.forEach((t, i) => {
        group.appendChild(traitRow(t, i >= SHOWN_PER_GROUP ? " tg-hidden" : ""));
      });
      if (items.length > SHOWN_PER_GROUP) {
        const more = document.createElement("span");
        more.className = "tg-more";
        more.textContent = `+ ${items.length - SHOWN_PER_GROUP} autres`;
        more.addEventListener("click", () => {
          group.querySelectorAll(".tg-hidden").forEach((r) => r.classList.remove("tg-hidden"));
          more.remove();
        });
        group.appendChild(more);
      }
      el["stats-traits"].appendChild(group);
    });
  }

  function renderStatsTable() {
    const g = State.statsGraph;
    if (!g) return;
    if (State.statsGrain === "entites") renderEntites(g);
    else if (State.statsGrain === "paires") renderPaires(g);
    else renderEnsemble(g);
  }

  function sortRows(rows, col, dir) {
    return rows.slice().sort((a, b) => {
      const x = a[col], y = b[col];
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }
  // cols : [{key,label,num?,html?}]. En-tête cliquable → tri.
  function buildTable(cols, rows, onRow) {
    const sort = State.statsSort;
    let display = rows;
    if (sort.col && cols.some((c) => c.key === sort.col)) display = sortRows(rows, sort.col, sort.dir);
    const t = document.createElement("table"); t.className = "stab";
    const htr = document.createElement("tr");
    cols.forEach((c) => {
      const th = document.createElement("th"); th.textContent = c.label;
      if (c.num) th.className = "num";
      th.addEventListener("click", () => {
        State.statsSort = { col: c.key, dir: sort.col === c.key ? -sort.dir : (c.num ? -1 : 1) };
        renderStatsTable();
      });
      htr.appendChild(th);
    });
    const thead = document.createElement("thead"); thead.appendChild(htr); t.appendChild(thead);
    const tb = document.createElement("tbody");
    display.forEach((r) => {
      const tr = document.createElement("tr");
      cols.forEach((c) => {
        const td = document.createElement("td");
        if (c.num) td.className = "num";
        if (c.html) td.innerHTML = c.html(r); else td.textContent = r[c.key];
        tr.appendChild(td);
      });
      if (onRow) tr.addEventListener("click", () => onRow(r));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    el["stats-table"].innerHTML = ""; el["stats-table"].appendChild(t);
  }

  function renderEntites(g) {
    const rows = g.nodes.filter((n) => n.kind === "entity").map((n) => ({
      id: n.id, label: n.label, type: n.type, color: n.color,
      liens: n.degree_raw, oeuvres: n.work_count, inter: round3(n.betweenness), comm: n.community,
    }));
    buildTable([
      { key: "label", label: "Entité", html: (r) => `<span class="stab-pill" style="background:${r.color}"></span>${esc(r.label)}` },
      { key: "type", label: "Type" },
      { key: "liens", label: "Liens", num: true },
      { key: "oeuvres", label: cap(unitP()), num: true },
      { key: "inter", label: "Intermédiarité", num: true },
      { key: "comm", label: "Communauté", num: true },
    ], rows, (r) => seeOnMap([r.id]));
  }

  function renderPaires(g) {
    const lab = {}; g.nodes.forEach((n) => { lab[n.id] = n.label; });
    const rows = g.edges.map((e) => ({
      a: lab[e.source] || e.source, b: lab[e.target] || e.target,
      poids: e.weight, src: e.source, tgt: e.target,
    }));
    if (!State.statsSort.col) State.statsSort = { col: "poids", dir: -1 };
    buildTable([
      { key: "a", label: "Entité A" },
      { key: "b", label: "Entité B" },
      { key: "poids", label: `${cap(unitP())} partagés`, num: true },
    ], rows, (r) => seeOnMap([r.src, r.tgt]));
  }

  function renderEnsemble(g) {
    const s = g.summary;
    const cards = [
      ["Nœuds", s.n_nodes], ["Liens", s.n_edges], ["Communautés", s.n_communities],
      ["Composantes", s.n_components], ["Densité", s.density], ["Degré moyen", s.avg_degree],
    ];
    let html = `<div class="stats-ensemble">` +
      cards.map(([k, v]) => `<div class="stat-card"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join("") +
      `</div>`;
    const top = s.top_central || [];
    if (top.length) html += `<div class="grp-label" style="margin-top:20px">Pivots (top centralité)</div>` +
      `<div class="stats-table" id="top-central"></div>`;
    el["stats-table"].innerHTML = html;
    if (top.length) {
      const host = document.getElementById("top-central");
      host.innerHTML = `<table class="stab"><thead><tr><th>Entité</th><th>Type</th><th class="num">Score</th></tr></thead><tbody>` +
        top.map((c) => `<tr data-id="${esc(c.id)}"><td>${esc(c.label)}</td><td>${esc(c.type || "")}</td><td class="num">${round3(c.value)}</td></tr>`).join("") +
        `</tbody></table>`;
      host.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => seeOnMap([tr.dataset.id])));
    }
  }
  function round3(x) { return x == null ? "" : Math.round(x * 1000) / 1000; }

  function areConnected(a, b) {
    const g = State.lastGraph;
    return !!g && g.edges.some((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));
  }
  function seeOnMap(refs) {
    if (!refs || !refs.length) return;
    closeStats();
    requestAnimationFrame(() => {
      const g = State.lastGraph;
      const present = refs.filter((id) => g && g.nodes.some((n) => n.id === id));
      if (!present.length) { flash("Hors de la vue carte courante (filtres / base)."); return; }
      NetView.centerOnNodes(present);
      if (present.length === 1) {
        selectNode(present[0]);                       // une entité → sa fiche
      } else if (present.length === 2 && areConnected(present[0], present[1])) {
        State.parcours = present.slice();             // un duo → parcours de 2 (arête en rouge)
        State.selected = present[1];
        highlightParcours(); updateParcoursBar(); showDetail(present[1]);
      } else {
        NetView.setFocus(present);                    // un ensemble → mise en évidence groupée
        State.parcours = [present[0]]; State.selected = present[0]; showDetail(present[0]);
      }
    });
  }

  // Si l'écran stats est ouvert en « vue courante », il suit les changements de filtres.
  function maybeSyncStats() { if (statsOpen() && State.statsScope === "view") loadStats(); }

  // Sérendipité : tire une entité AU HASARD dans la vue courante et ouvre sa fiche (qui la
  // situe par ses stats). Tirage franchement aléatoire — la découverte, pas un top déguisé.
  function randomDiscover() {
    const nodes = (State.lastGraph && State.lastGraph.nodes) || [];
    const pool = nodes.filter((n) => n.kind === "entity");
    const from = pool.length ? pool : nodes;
    if (!from.length) { flash("Rien à explorer dans cette vue."); return; }
    const pick = from[Math.floor(Math.random() * from.length)];
    if (statsOpen()) closeStats();
    requestAnimationFrame(() => { NetView.centerOnNodes([pick.id]); selectNode(pick.id); });
  }

  // Synthèse texte : on assemble les phrases factuelles déjà produites par /salience
  // (gabarits déterministes, généré localement — aucun appel externe).
  function exportSalienceText() {
    const sal = State.lastSalience;
    if (!sal || !(sal.traits || []).length) { flash("Rien à exporter dans la synthèse."); return; }
    const s = (State.statsGraph && State.statsGraph.summary) || {};
    const scopeLabel = State.statsScope === "base" ? "base entière" : "vue courante";
    const lines = [`Statistiques — ${State.filename || ""} (${scopeLabel})`];
    if (s.n_nodes != null) lines.push(`${s.n_nodes} nœuds · ${s.n_edges} liens · ${s.n_communities} communautés`);
    lines.push("", "CE QUI RESSORT", "==============", "");
    const byKind = {};
    sal.traits.forEach((t) => { (byKind[t.kind] = byKind[t.kind] || []).push(t); });
    KIND_ORDER.filter((k) => byKind[k])
      .concat(Object.keys(byKind).filter((k) => !KIND_ORDER.includes(k)))
      .forEach((kind) => {
        lines.push(KIND_LABEL[kind] || kind);
        byKind[kind].forEach((t) => lines.push("  - " + t.detail));
        lines.push("");
      });
    downloadBlob(new Blob([lines.join("\r\n")], { type: "text/plain;charset=utf-8" }), "synthese-stats.txt");
  }

  // POST /export sur la vue du PÉRIMÈTRE stats (State.statsGraph) → renvoie le blob.
  async function fetchStatsExport(kind, format) {
    const g = State.statsGraph;
    if (!g) { flash("Rien à exporter."); return null; }
    try {
      const body = {
        session_id: State.sessionId, kind, format,
        view: { nodes: g.nodes, edges: g.edges },
        title: State.filename, unit_singular: unitS(), unit_plural: unitP(),
      };
      const res = await api("/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return await res.blob();
    } catch (e) { flash("Échec export : " + e.message); return null; }
  }
  async function downloadStatsExport(kind, format, fallback) {
    const blob = await fetchStatsExport(kind, format);
    if (blob) downloadBlob(blob, fallback);
  }

  // Tableau du grain courant : entités/ensemble → métriques ; paires → arêtes.
  function exportStatsTable(format) {
    const paires = State.statsGrain === "paires";
    if (paires && format === "xlsx") flash("Les paires s'exportent en CSV.");
    const kind = paires ? "csv_edges" : "metrics";    // pas de XLSX pour les arêtes → CSV
    const fmt = paires ? "csv" : format;
    downloadStatsExport(kind, fmt, `stats.${fmt}`);
  }

  // Graphiques : on AFFICHE d'abord l'aperçu (PNG), avec téléchargement PNG/SVG dessous.
  async function showChart(kind, label) {
    el["chart-title"].textContent = "Graphique — calcul…";
    el["stats-chart-block"].style.display = "";
    const blob = await fetchStatsExport(kind, "png");
    if (!blob) { hideChart(); return; }
    State.chartKind = kind;
    if (State.chartUrl) URL.revokeObjectURL(State.chartUrl);
    State.chartUrl = URL.createObjectURL(blob);
    el["chart-preview"].innerHTML = `<img src="${State.chartUrl}" alt="${esc(label)}">`;
    el["chart-title"].textContent = label;
    el["stats-chart-block"].scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function hideChart() {
    el["stats-chart-block"].style.display = "none";
    el["chart-preview"].innerHTML = "";
    if (State.chartUrl) { URL.revokeObjectURL(State.chartUrl); State.chartUrl = null; }
    State.chartKind = null;
  }

  function initStats() {
    el["stats-btn"].addEventListener("click", openStats);
    el["stats-close"].addEventListener("click", closeStats);
    el["hasard-btn"].addEventListener("click", randomDiscover);
    el["hasard-btn-stats"].addEventListener("click", randomDiscover);
    el["exp-synth"].addEventListener("click", exportSalienceText);
    el["exp-tab-csv"].addEventListener("click", () => exportStatsTable("csv"));
    el["exp-tab-xlsx"].addEventListener("click", () => exportStatsTable("xlsx"));
    el["exp-bars"].addEventListener("click", () => showChart("bars", "Top entités par liens"));
    el["exp-histo"].addEventListener("click", () => showChart("histogram", "Entités par année moyenne"));
    el["exp-matrix"].addEventListener("click", () => showChart("matrix", "Co-occurrences (top entités)"));
    el["chart-dl-png"].addEventListener("click", () => { if (State.chartKind) downloadStatsExport(State.chartKind, "png", `${State.chartKind}.png`); });
    el["chart-dl-svg"].addEventListener("click", () => { if (State.chartKind) downloadStatsExport(State.chartKind, "svg", `${State.chartKind}.svg`); });
    el["chart-hide"].addEventListener("click", hideChart);
    wireSeg(el["stats-scope"], (v) => { State.statsScope = v; State.statsSort = { col: null, dir: -1 }; loadStats(); });
    wireSeg(el["stats-grain"], (v) => { State.statsGrain = v; State.statsSort = { col: null, dir: -1 }; renderStatsTable(); });
  }

  // ------------------------------------------------------------------ export
  function initExport() {
    el["exp-close"].addEventListener("click", () => el["export-overlay"].classList.add("hidden"));
    el["exp-image"].addEventListener("click", () => doExport("image", el["exp-format"].value));
    document.querySelectorAll("[data-exp]").forEach((b) =>
      b.addEventListener("click", () => doExport(b.dataset.exp, b.dataset.fmt || "csv")));
  }

  // Couleurs de surlignage — identiques aux reducers de render.js (cohérence écran↔export).
  const EXP_EDGE_HOT = "#B8453F";     // arête incidente à la sélection
  const EXP_FADE = 0.16;              // opacité du « fond » estompé

  function currentView() {
    const scope = el["exp-scope"].value;
    // Voisinage : on RECADRE sur le nœud + ses voisins (le reste est jeté).
    if (scope === "neighbors" && State.selected) {
      const idFilter = NetView.neighborhood(State.selected, +el["exp-hops"].value);
      return { nodes: NetView.getViewNodes(idFilter), edges: NetView.getViewEdges(idFilter) };
    }
    // Sélection en évidence : on garde TOUT le graphe, mais on met la sélection (+ voisinage)
    // en avant et on estompe le reste — exactement comme à l'écran après un clic.
    if (scope === "highlight" && State.selected) {
      const sel = State.selected;
      const hl = NetView.neighborhood(sel, +el["exp-hops"].value);
      const nodes = NetView.getViewNodes(null).map((n) => ({
        ...n,
        alpha: hl.has(n.id) ? 1 : EXP_FADE,
        selected: n.id === sel || undefined,        // toujours étiqueté
      }));
      const edges = NetView.getViewEdges(null).map((e) => {
        const hot = e.source === sel || e.target === sel;        // rouge, comme EDGE_HOT
        const inSet = hl.has(e.source) && hl.has(e.target);
        return { ...e, color: hot ? EXP_EDGE_HOT : undefined, alpha: (hot || inSet) ? 1 : EXP_FADE };
      });
      return { nodes, edges };
    }
    return { nodes: NetView.getViewNodes(null), edges: NetView.getViewEdges(null) };
  }

  async function doExport(kind, format) {
    // Les périmètres « voisinage » et « sélection en évidence » exigent une sélection.
    const scope = el["exp-scope"].value;
    if (kind === "image" && (scope === "neighbors" || scope === "highlight") && !State.selected) {
      el["exp-status"].textContent = "Sélectionnez d'abord un nœud (clic sur la carte).";
      return;
    }
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
      // Confirme le périmètre réellement appliqué (aide au diagnostic).
      const note = (kind === "image" && scope === "highlight" && State.selected)
          ? " — sélection en évidence" :
        (kind === "image" && scope === "neighbors" && State.selected)
          ? " — voisinage recadré" : "";
      el["exp-status"].textContent = "Téléchargé ✓" + note;
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
        connectors: [...State.connectors].join(","),   // même lentille que la vue courante
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
