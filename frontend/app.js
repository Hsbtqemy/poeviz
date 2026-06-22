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
    search: "",
    selected: null,
    lastGraph: null,
    layoutSig: null,
  };

  const $ = (id) => document.getElementById(id);
  const el = {};
  ["upload-screen", "dropzone", "file-input", "demo-btn", "upload-err",
   "roles-overlay", "roles-body", "roles-hint", "roles-build", "roles-cancel", "roles-status",
   "app", "brand-sub", "search", "pivot-list", "layers-list", "hinge-layer", "reconfig",
   "adv", "adv-toggle", "seg-link", "seg-pivot", "seg-color", "seg-labels",
   "size-by", "layout-sel", "display-mode", "rail-foot",
   "yr-min", "yr-max", "yr-lo", "yr-hi", "yr-reset", "timewrap",
   "export-btn", "share-btn", "detail", "dhead", "d-title", "d-sub", "dbody", "dclose",
   "statusline",
   "export-overlay", "exp-scope", "exp-hops", "exp-format", "exp-dim", "exp-labels",
   "exp-image", "exp-close", "exp-status"
  ].forEach((id) => { el[id] = $(id); });

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
    showRoles();
    // Raccourci de validation : ?auto=1 construit directement avec les rôles suggérés.
    if (/[?&]auto=1/.test(location.search)) buildGraph();
  }

  // --------------------------------------------------------- écran des rôles
  const ROLE_LABELS = { node: "Nœud", edge: "Lien", attribute: "Info", ignore: "Ignoré" };
  let workingRoles = {};

  function showRoles() {
    workingRoles = {};
    State.profile.columns.forEach((c) => { workingRoles[c.name] = c.suggested_role; });
    el["roles-body"].innerHTML = "";
    State.profile.columns.forEach((c) => el["roles-body"].appendChild(rolesRow(c)));
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
    const ok = by.node.length > 0;
    el["roles-build"].disabled = !ok;
    el["roles-status"].textContent = ok ? "" : "Choisissez au moins une colonne « Nœud ».";
  }

  el["roles-cancel"].addEventListener("click", () => el["roles-overlay"].classList.add("hidden"));
  el["reconfig"].addEventListener("click", showRoles);
  el["roles-build"].addEventListener("click", buildGraph);

  async function buildGraph() {
    el["roles-status"].innerHTML = `<span class="spinner"></span> Construction…`;
    try {
      const cfg = await postJSON("/configure", { session_id: State.sessionId, roles: workingRoles });
      State.summary = cfg.summary;
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
        container: $("sigma"), cards: $("cards"), tooltip: $("tooltip"), statusEl: el["statusline"],
        onSelect: selectNode, onBackground: deselect,
      });
      window.__netInit = true;
      window.addEventListener("resize", () => NetView.resize());
    }

    buildPivotList();
    buildLayers();
    buildTimeline();
    el["rail-foot"].textContent =
      `${State.summary.n_works} ouvrages · ${State.summary.n_nodes_total} entités`;
    refreshGraph();
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
      refreshGraph();
    };
  }

  // --------------------------------------------------------------- timeline
  function buildTimeline() {
    if (State.fullYearMin == null) { el["timewrap"].style.display = "none"; return; }
    el["timewrap"].style.display = "";
    [el["yr-min"], el["yr-max"]].forEach((s) => { s.min = State.fullYearMin; s.max = State.fullYearMax; });
    el["yr-min"].value = State.fullYearMin; el["yr-max"].value = State.fullYearMax;
    updateYearLabels();
    let t = null;
    const onInput = () => {
      let lo = +el["yr-min"].value, hi = +el["yr-max"].value;
      if (lo > hi) { if (document.activeElement === el["yr-min"]) hi = lo; else lo = hi; el["yr-min"].value = lo; el["yr-max"].value = hi; }
      State.yearMin = lo; State.yearMax = hi; updateYearLabels();
      clearTimeout(t); t = setTimeout(() => refreshGraph(), 140);
    };
    el["yr-min"].oninput = onInput; el["yr-max"].oninput = onInput;
    el["yr-reset"].onclick = () => {
      State.yearMin = State.fullYearMin; State.yearMax = State.fullYearMax;
      el["yr-min"].value = State.fullYearMin; el["yr-max"].value = State.fullYearMax;
      updateYearLabels(); refreshGraph();
    };
  }
  function updateYearLabels() { el["yr-lo"].textContent = State.yearMin; el["yr-hi"].textContent = State.yearMax; }

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
    initExport();
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
      });
      State.layoutSig = sig;
      NetView.setLabelsDensity(State.labels);
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
    } catch (e) { flash("Erreur : " + e.message); }
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
    el["d-sub"].textContent = d.kind === "work" ? "Ouvrage" : d.type;

    let html = "";
    if (d.kind === "work") {
      if (d.year != null) html += stat("Année", d.year);
      Object.entries(d.attributes || {}).forEach(([k, v]) => { html += stat(k, v); });
      Object.entries(d.neighbors_by_type || {}).forEach(([t, arr]) => { html += stat(t, arr.join(", ")); });
    } else {
      html += stat("Ouvrages", `${d.work_count} ouvrage${d.work_count > 1 ? "s" : ""}`);
      if (d.period) html += stat("Période d'activité", d.period[0] === d.period[1] ? d.period[0] : `${d.period[0]} – ${d.period[1]}`);
      if (meta.community != null) html += stat("Communauté", "Groupe " + (meta.community + 1));
      if (meta.degree != null) html += stat("Centralité (degré)", meta.degree_raw + " liens" + (meta.size >= 16 ? " — nœud pivot" : ""));
      Object.entries(d.neighbors_by_type || {}).forEach(([t, arr]) => {
        html += `<div class="stat"><div class="k">${esc(t)}</div><div class="v">${arr.slice(0, 12).map((x) => `<span class="dtag">${esc(x)}</span>`).join("")}</div></div>`;
      });
      if (d.works && d.works.length) {
        html += `<div class="k" style="font-size:9.5px;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:bold;margin:6px 0 8px">Ouvrages</div>`;
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
      };
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

  // ------------------------------------------------------------------ boot
  initUpload();
  initControls();
  // Raccourci de validation/démo : ?auto=1 charge la démo et construit la carte.
  if (/[?&]auto=1/.test(location.search)) loadDemo();
})();
