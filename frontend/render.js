/* =========================================================================
   render.js — Couche de rendu réseau (Sigma.js v3 + graphology).
   Responsabilités : construire le graphe, disposer (ForceAtlas2 / circulaire),
   gérer les niveaux de détail (points → étiquettes → cartes), le survol, la
   sélection avec mise en évidence du voisinage, l'épinglage de cartes, le
   déplacement de nœuds à la souris, et le partage des positions pour l'export.

   Les positions sont mises en cache (posCache) et réutilisées d'un appel à
   l'autre : déplacer le curseur temporel ne relance donc PAS la disposition,
   les nœuds restent stables. Seuls les changements structurels relayoutent.
   ========================================================================= */
(function () {
  "use strict";

  // --- Résolution robuste des globals UMD ---
  const Graph = (window.graphology && (window.graphology.Graph || window.graphology.default || window.graphology));
  const SigmaCtor = window.Sigma && (window.Sigma.Sigma || window.Sigma);
  const Lib = window.graphologyLibrary || {};
  const FA2 = Lib.layoutForceAtlas2;
  const basicLayouts = Lib.layout || {};

  const EDGE_BASE = "#CFC9BD";
  const EDGE_FADE = "#EAE6DC";
  const EDGE_HOT = "#B8453F";

  let sigma = null;
  let graph = null;
  let cardsEl = null, tooltipEl = null, statusEl = null, timeAxisEl = null;
  let callbacks = {};
  const posCache = Object.create(null);   // id -> {x,y} (positions vivantes, persistant)
  const structPos = Object.create(null);  // id -> {x,y} (dernière dispo structurelle force/circ/random)

  // mode « réseau temporel » : X = temps, Y = celui de la disposition force (préservé)
  const TEMPORAL_WIDTH = 1200;
  let temporalMode = false, tYearMin = null, tYearMax = null;

  let focusSet = null;        // ids à garder en évidence (null = tout)
  let selected = null;        // nœud cliqué
  let labelsDensity = "pivots";
  let displayMode = "auto";   // auto | points | cards
  let unitSingular = "objet", unitPlural = "objets";  // nom de la charnière (réglable)
  let cardFields = [];        // colonnes à afficher sur la carte d'une charnière
  let hoveredEdge = null;     // arête survolée (anti-bulle fantôme sur réponse async)
  let cardData = {};          // {id charnière: {champ: valeur}} — chargé une fois via /cards
  let lodMode = "labels";     // points | labels | cards (résolu selon zoom)
  let pivotCutoff = 0;        // taille mini pour étiqueter en mode "pivots"
  const pinned = new Set();   // cartes épinglées
  const cardDivs = new Map(); // id -> div (overlay)

  // ---------------------------------------------------------------- init
  function init(opts) {
    cardsEl = opts.cards; tooltipEl = opts.tooltip; statusEl = opts.statusEl;
    timeAxisEl = opts.timeAxis;
    callbacks = opts;
    graph = new Graph({ multi: false, type: "undirected" });
    sigma = new SigmaCtor(graph, opts.container, {
      defaultEdgeColor: EDGE_BASE,
      labelFont: "system-ui, Arial, sans-serif",
      labelSize: 11,
      labelWeight: "600",
      labelColor: { color: "#23201C" },
      labelRenderedSizeThreshold: 0,
      enableEdgeEvents: true,
      zIndex: true,
      minCameraRatio: 0.05,
      maxCameraRatio: 20,
      nodeReducer, edgeReducer,
    });

    sigma.on("clickNode", (e) => callbacks.onSelect && callbacks.onSelect(e.node));
    sigma.on("clickStage", () => callbacks.onBackground && callbacks.onBackground());
    sigma.on("enterNode", (e) => showTooltip(e.node));
    sigma.on("leaveNode", hideTooltip);
    // Survol d'une arête → on demande au contrôleur « pourquoi reliés » et on
    // affiche la réponse en info-bulle (les arêtes ne sont plus anonymes).
    sigma.on("enterEdge", (e) => onEdgeEnter(e.edge));
    sigma.on("leaveEdge", () => { hoveredEdge = null; hideTooltip(); });
    sigma.getCamera().on("updated", () => { updateLOD(); scheduleCards(); updateTimeAxis(); });
    sigma.on("afterRender", () => { scheduleCards(); updateTimeAxis(); });

    setupDrag();
  }

  // ------------------------------------------------------- reducers (LOD/focus)
  function nodeReducer(node, data) {
    const res = Object.assign({}, data);
    const inFocus = !focusSet || focusSet.has(node);
    if (!inFocus) {
      res.color = fade(data.color);
      res.label = "";
      res.zIndex = 0;
      return res;
    }
    res.zIndex = (node === selected) ? 3 : (focusSet ? 2 : 1);
    // Étiquettes : pilotées par le niveau de détail + la densité choisie.
    let showLabel = false;
    if (lodMode !== "points") {
      if (labelsDensity === "all") showLabel = true;
      else if (labelsDensity === "pivots") showLabel = data.size >= pivotCutoff;
    }
    if (focusSet && focusSet.has(node)) showLabel = showLabel || (lodMode !== "points");
    if (node === selected) showLabel = true;
    // En mode "cartes", l'étiquette texte est remplacée par la carte HTML.
    if (lodMode === "cards" && cardDivs.has(node)) showLabel = false;
    res.label = showLabel ? data.label : "";
    return res;
  }

  function edgeReducer(edge, data) {
    const res = Object.assign({}, data);
    if (!focusSet) { res.color = EDGE_BASE; return res; }
    const ext = graph.extremities(edge);
    const inFocus = focusSet.has(ext[0]) && focusSet.has(ext[1]);
    if (selected && (ext[0] === selected || ext[1] === selected)) {
      res.color = EDGE_HOT; res.size = Math.max(data.size || 1, 2); res.zIndex = 2;
    } else if (inFocus) {
      res.color = EDGE_BASE;
    } else {
      res.color = EDGE_FADE; res.zIndex = 0;
    }
    return res;
  }

  function fade(hex) {
    // Estompe une couleur vers le crème (≈28% d'opacité visuelle).
    const c = hexToRgb(hex), bg = [247, 244, 238], a = 0.22;
    return rgbToHex(c.map((v, i) => Math.round(v * a + bg[i] * (1 - a))));
  }

  // ------------------------------------------------------------------- render
  function render(data, opts) {
    opts = opts || {};
    graph.clear();
    cardDivs.forEach((d) => d.remove()); cardDivs.clear();

    data.nodes.forEach((n) => {
      const cached = posCache[n.id];
      graph.addNode(n.id, {
        label: n.label, size: n.size, color: n.color,
        x: cached ? cached.x : (n.x || 0),
        y: cached ? cached.y : (n.y || 0),
        ntype: n.type, kind: n.kind, work_count: n.work_count,
        mean_year: n.mean_year, baseSize: n.size,
        community: n.community, baseColor: n.color,
      });
    });
    data.edges.forEach((e) => {
      if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.source, e.target)) {
        // Épaisseur min relevée : la zone de survol d'une arête = son épaisseur,
        // donc des arêtes trop fines sont difficiles à viser. Min ≈ 2 px.
        graph.addEdge(e.source, e.target, { size: Math.min(1.6 + 0.4 * (e.weight || 1), 6), weight: e.weight || 1 });
      }
    });

    computePivotCutoff();

    temporalMode = (opts.layoutKind === "temporal");
    tYearMin = opts.yearMin; tYearMax = opts.yearMax;

    if (opts.relayout) {
      layout(opts.layoutKind || "force", opts);
      if (opts.pivot && opts.pivotMode === "reorganize" && !temporalMode) centerPivot(opts.pivot);
      savePositions();
      sigma.getCamera().animatedReset();
    } else if (temporalMode) {
      applyTemporalSizing();   // garde la taille = nb d'ouvrages au scrub temporel
    }
    updateLOD();
    sigma.refresh();
    scheduleCards();
    updateTimeAxis();
    if (statusEl) statusEl.textContent =
      `${graph.order} nœuds · ${graph.size} liens`;
  }

  // -------------------------------------------------------------- dispositions
  function layout(kind, opts) {
    if (graph.order === 0) return;
    if (kind === "temporal") {
      temporalLayout((opts && opts.yearMin), (opts && opts.yearMax));
      return;
    }
    if (kind === "circular" && basicLayouts.circular) {
      basicLayouts.circular.assign(graph, { scale: 10 });
    } else if (kind === "random" && basicLayouts.random) {
      basicLayouts.random.assign(graph, { scale: 20, center: 0 });
    } else if (FA2) {
      const settings = FA2.inferSettings ? FA2.inferSettings(graph) : {};
      settings.gravity = 1.2;
      settings.scalingRatio = 12;
      settings.barnesHutOptimize = graph.order > 300;
      settings.adjustSizes = true;
      FA2.assign(graph, { iterations: Math.min(420, 120 + graph.order * 3), settings });
    }
    // Mémorise cette disposition « structurelle » : le mode temporel réutilisera
    // son Y pour garder la MÊME carte, juste glissée sur l'axe du temps.
    graph.forEachNode((id, a) => { structPos[id] = { x: a.x, y: a.y }; });
  }

  // Réseau temporel : on GARDE la disposition force des boules (leur Y) et on
  // se contente de fixer X selon l'année moyenne. La carte reste reconnaissable,
  // simplement étirée/calée sur un axe temporel. On ne relance PAS ForceAtlas2.
  function temporalLayout(ymin, ymax) {
    if (ymin == null || ymax == null) { return; }
    // Si aucune disposition structurelle mémorisée, en calculer une d'abord.
    if (!hasStruct() && FA2) {
      const s = FA2.inferSettings ? FA2.inferSettings(graph) : {};
      FA2.assign(graph, { iterations: 200, settings: s });
      graph.forEachNode((id, a) => { structPos[id] = { x: a.x, y: a.y }; });
    }
    const span = (ymax - ymin) || 1;
    // Étendue verticale de la disposition structurelle → mise à l'échelle.
    let lo = Infinity, hi = -Infinity;
    graph.forEachNode((id) => { const p = structPos[id]; if (p) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); } });
    if (!isFinite(lo)) { lo = -1; hi = 1; }
    const yMid = (lo + hi) / 2, yScale = (TEMPORAL_WIDTH * 0.5) / ((hi - lo) || 1);
    let maxWC = 1;
    graph.forEachNode((id, a) => { maxWC = Math.max(maxWC, a.work_count || 1); });
    graph.forEachNode((id, a) => {
      const my = a.mean_year;
      const x = (my == null) ? -120 : ((my - ymin) / span) * TEMPORAL_WIDTH;
      const p = structPos[id];
      const fy = p ? p.y : (a.y || 0);
      graph.setNodeAttribute(id, "x", x);
      graph.setNodeAttribute(id, "y", (fy - yMid) * yScale);   // Y de la carte force, préservé
      graph.setNodeAttribute(id, "size", 5 + 16 * ((a.work_count || 1) / maxWC));  // taille = nb d'ouvrages
    });
  }

  function hasStruct() { return Object.keys(structPos).length > 0; }

  function applyTemporalSizing() {
    let maxWC = 1;
    graph.forEachNode((id, a) => { maxWC = Math.max(maxWC, a.work_count || 1); });
    graph.forEachNode((id, a) => graph.setNodeAttribute(id, "size", 5 + 16 * ((a.work_count || 1) / maxWC)));
  }

  function updateTimeAxis() {
    if (!timeAxisEl) return;
    if (!temporalMode || tYearMin == null || tYearMax == null) {
      timeAxisEl.classList.add("hidden"); timeAxisEl.innerHTML = ""; return;
    }
    timeAxisEl.classList.remove("hidden");
    const span = (tYearMax - tYearMin) || 1;
    const step = axisStep(span);
    let html = '<div class="axis-line"></div>';
    for (let yr = Math.ceil(tYearMin / step) * step; yr <= tYearMax; yr += step) {
      const gx = ((yr - tYearMin) / span) * TEMPORAL_WIDTH;
      const vp = sigma.graphToViewport({ x: gx, y: 0 });
      html += `<span class="tick" style="left:${vp.x}px">${yr}</span>`;
    }
    timeAxisEl.innerHTML = html;
  }
  function axisStep(span) {
    for (const s of [1, 2, 5, 10, 20, 25, 50, 100]) if (span / s <= 10) return s;
    return 200;
  }

  function centerPivot(pivotType) {
    // « réorganise » : on rapproche du centre les nœuds du type pivot.
    let cx = 0, cy = 0, k = 0;
    graph.forEachNode((id, a) => { if (a.ntype === pivotType) { cx += a.x; cy += a.y; k++; } });
    if (!k) return;
    cx /= k; cy /= k;
    graph.forEachNode((id, a) => { graph.setNodeAttribute(id, "x", a.x - cx); graph.setNodeAttribute(id, "y", a.y - cy); });
    // Tire les nœuds-pivots un peu vers le centre pour les rendre saillants.
    graph.forEachNode((id, a) => {
      if (a.ntype === pivotType) {
        graph.setNodeAttribute(id, "x", a.x * 0.45);
        graph.setNodeAttribute(id, "y", a.y * 0.45);
      }
    });
  }

  function savePositions() {
    graph.forEachNode((id, a) => { posCache[id] = { x: a.x, y: a.y }; });
  }

  function computePivotCutoff() {
    const sizes = [];
    graph.forEachNode((id, a) => sizes.push(a.size));
    if (!sizes.length) { pivotCutoff = 0; return; }
    sizes.sort((a, b) => a - b);
    // étiquette ≈ le top 25 %
    pivotCutoff = sizes[Math.floor(sizes.length * 0.75)] || sizes[sizes.length - 1];
  }

  // ------------------------------------------------------------- LOD selon zoom
  function updateLOD() {
    const r = sigma ? sigma.getCamera().ratio : 1;
    if (displayMode === "points") lodMode = "points";
    else if (displayMode === "cards") lodMode = "cards";
    else lodMode = r > 1.5 ? "points" : (r < 0.55 ? "cards" : "labels");
  }

  // ------------------------------------------------------------- cartes overlay
  let cardRAF = null;
  function scheduleCards() {
    if (cardRAF) return;
    cardRAF = requestAnimationFrame(() => { cardRAF = null; renderCards(); });
  }

  function renderCards() {
    if (!cardsEl) return;
    const showCards = (lodMode === "cards");
    const wanted = new Set();
    const rect = cardsEl.getBoundingClientRect();

    graph.forEachNode((id, a) => {
      const isPinned = pinned.has(id);
      if (!showCards && !isPinned) return;
      if (focusSet && !focusSet.has(id) && !isPinned) return;
      const p = sigma.graphToViewport({ x: a.x, y: a.y });
      if (!isPinned && (p.x < -40 || p.y < -40 || p.x > rect.width + 40 || p.y > rect.height + 40)) return;
      // En mode cartes sans épinglage, on limite au top des nœuds visibles pour rester lisible.
      if (showCards && !isPinned && a.size < pivotCutoff * 0.6 && graph.order > 40) return;
      wanted.add(id);
      placeCard(id, a, p, isPinned);
    });
    // Retire les cartes qui ne sont plus voulues.
    cardDivs.forEach((div, id) => { if (!wanted.has(id)) { div.remove(); cardDivs.delete(id); } });
  }

  function placeCard(id, a, p, isPinned) {
    let div = cardDivs.get(id);
    if (!div) {
      div = document.createElement("div");
      div.className = "ncard";
      div.innerHTML = `<div class="band"></div><div class="body"><div class="t"></div><div class="s"></div></div><span class="pin-btn" title="Épingler">📌</span>`;
      div.querySelector(".band").style.background = a.baseColor;
      div.querySelector(".t").textContent = a.label;
      if (a.kind === "work") {
        // Carte d'un livre : champs choisis par l'utilisateur (réglables à la volée).
        // Les valeurs viennent de cardData (chargé une fois via /cards), pas du nœud.
        const card = cardData[id];
        const lines = [];
        (cardFields || []).forEach((f) => {
          const v = card && card[f];
          if (v != null && v !== "") lines.push(`${escapeHtml(f)} : ${escapeHtml(String(v))}`);
        });
        div.querySelector(".s").innerHTML = lines.length ? lines.join("<br>") : escapeHtml(cap(unitSingular));
      } else {
        const sub = `${a.ntype || ""}${a.work_count ? " · " + a.work_count + " " + (a.work_count > 1 ? unitPlural : unitSingular) : ""}`;
        div.querySelector(".s").textContent = sub;
      }
      div.querySelector(".pin-btn").addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (pinned.has(id)) pinned.delete(id); else pinned.add(id);
        scheduleCards();
      });
      div.addEventListener("click", () => callbacks.onSelect && callbacks.onSelect(id));
      cardsEl.appendChild(div);
      cardDivs.set(id, div);
    }
    div.classList.toggle("pinned", isPinned);
    div.style.left = p.x + "px";
    div.style.top = p.y + "px";
  }

  // ------------------------------------------------------------------ tooltip
  function showTooltip(node) {
    if (!tooltipEl) return;
    const a = graph.getNodeAttributes(node);
    const p = sigma.graphToViewport({ x: a.x, y: a.y });
    tooltipEl.innerHTML = `${escapeHtml(a.label)}<div class="t2">${escapeHtml(a.kind === "work" ? cap(unitSingular) : (a.ntype || ""))}</div>`;
    tooltipEl.style.left = p.x + "px";
    tooltipEl.style.top = p.y + "px";
    tooltipEl.style.opacity = "1";
    if (sigma.getContainer()) sigma.getContainer().style.cursor = "pointer";
  }
  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.opacity = "0";
    if (sigma.getContainer()) sigma.getContainer().style.cursor = "default";
  }

  function onEdgeEnter(edge) {
    if (!callbacks.onEdgeHover || !graph.hasEdge(edge)) return;
    hoveredEdge = edge;
    const ext = graph.extremities(edge);
    if (sigma.getContainer()) sigma.getContainer().style.cursor = "help";
    // Le contrôleur récupère l'explication (async) puis nous rappelle pour afficher.
    // On n'affiche que si on survole TOUJOURS la même arête (anti-bulle fantôme).
    callbacks.onEdgeHover(ext[0], ext[1], (html) => {
      if (hoveredEdge === edge) showEdgeTooltip(ext[0], ext[1], html);
    });
  }

  function showEdgeTooltip(s, t, html) {
    if (!tooltipEl || !graph.hasNode(s) || !graph.hasNode(t)) return;
    const a = graph.getNodeAttributes(s), b = graph.getNodeAttributes(t);
    const p = sigma.graphToViewport({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    tooltipEl.innerHTML = html;
    tooltipEl.style.left = p.x + "px";
    tooltipEl.style.top = p.y + "px";
    tooltipEl.style.opacity = "1";
  }

  // --------------------------------------------------------------- sélection
  function setHighlight(node) {
    selected = node;
    if (node && graph.hasNode(node)) {
      focusSet = new Set([node]);
      graph.forEachNeighbor(node, (nb) => focusSet.add(nb));
    } else {
      focusSet = null;
    }
    sigma.refresh();
    scheduleCards();
  }

  function setFocus(ids) {
    selected = null;
    focusSet = (ids && ids.length) ? new Set(ids) : null;
    sigma.refresh(); scheduleCards();
  }

  function applySearch(query) {
    query = (query || "").trim().toLowerCase();
    if (!query) { if (!selected) { focusSet = null; sigma.refresh(); scheduleCards(); } return; }
    const matches = [];
    graph.forEachNode((id, a) => { if (a.label && a.label.toLowerCase().includes(query)) matches.push(id); });
    selected = null;
    focusSet = matches.length ? new Set(matches) : new Set(["__none__"]);
    sigma.refresh(); scheduleCards();
    if (matches.length) centerOnNodes(matches);
  }

  function centerOnNodes(ids) {
    if (!ids.length) return;
    let x = 0, y = 0;
    ids.forEach((id) => { const a = graph.getNodeAttributes(id); x += a.x; y += a.y; });
    x /= ids.length; y /= ids.length;
    const cam = sigma.getCamera();
    const vp = sigma.graphToViewport({ x, y });
    const target = sigma.viewportToFramedGraph(vp);
    cam.animate({ x: target.x, y: target.y, ratio: ids.length === 1 ? 0.5 : cam.ratio }, { duration: 350 });
  }

  // --------------------------------------------------------------- drag souris
  function setupDrag() {
    let dragged = null, isDragging = false;
    sigma.on("downNode", (e) => { isDragging = true; dragged = e.node; hideTooltip(); });
    const captor = sigma.getMouseCaptor();
    captor.on("mousemovebody", (e) => {
      if (!isDragging || !dragged) return;
      const pos = sigma.viewportToGraph(e);
      graph.setNodeAttribute(dragged, "x", pos.x);
      graph.setNodeAttribute(dragged, "y", pos.y);
      e.preventSigmaDefault(); e.original.preventDefault(); e.original.stopPropagation();
    });
    const stop = () => {
      if (dragged) { posCache[dragged] = { x: graph.getNodeAttribute(dragged, "x"), y: graph.getNodeAttribute(dragged, "y") }; }
      isDragging = false; dragged = null; scheduleCards();
    };
    captor.on("mouseup", stop);
    captor.on("mouseupbody", stop);
  }

  // -------------------------------------------------------- réglages dynamiques
  function setLabelsDensity(v) { labelsDensity = v; sigma.refresh(); }
  function setDisplayMode(v) { displayMode = v; updateLOD(); sigma.refresh(); scheduleCards(); }
  function setUnitLabels(sing, plur) {
    unitSingular = sing || "objet"; unitPlural = plur || "objets";
    // Le libellé d'unité est figé dans le texte des cartes → on les reconstruit.
    cardDivs.forEach((d) => d.remove()); cardDivs.clear();
    if (sigma) { scheduleCards(); }
  }
  function setCardFields(fields) {
    cardFields = fields || [];
    // Force la reconstruction des cartes (leur contenu est figé à la création).
    cardDivs.forEach((d) => d.remove()); cardDivs.clear();
    if (sigma) scheduleCards();
  }
  function setCardData(map) {
    cardData = map || {};
    // Le texte d'une carte est figé à sa création → on les reconstruit.
    cardDivs.forEach((d) => d.remove()); cardDivs.clear();
    if (sigma) scheduleCards();
  }
  function resize() { if (sigma) sigma.refresh(); scheduleCards(); }

  // --------------------------------------------------- extraction pour l'export
  function getViewNodes(idFilter) {
    const out = [];
    graph.forEachNode((id, a) => {
      if (idFilter && !idFilter.has(id)) return;
      out.push({
        id, label: a.label, type: a.ntype, kind: a.kind, color: a.baseColor,
        size: a.size, x: a.x, y: a.y, community: a.community, work_count: a.work_count,
      });
    });
    return out;
  }
  function getViewEdges(idFilter) {
    const out = [];
    graph.forEachEdge((e, attr, s, t) => {
      if (idFilter && (!idFilter.has(s) || !idFilter.has(t))) return;
      out.push({ source: s, target: t, weight: attr.weight || 1 });
    });
    return out;
  }
  function neighborhood(node, hops) {
    const set = new Set([node]);
    let frontier = [node];
    for (let h = 0; h < hops; h++) {
      const next = [];
      frontier.forEach((n) => graph.forEachNeighbor(n, (nb) => { if (!set.has(nb)) { set.add(nb); next.push(nb); } }));
      frontier = next;
    }
    return set;
  }

  function hexToRgb(hex) {
    const h = (hex || "#7B5BD6").replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHex(c) { return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join(""); }
  function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  function getPositions() {
    const out = {};
    graph.forEachNode((id, a) => { out[id] = { x: a.x, y: a.y }; });
    return out;
  }

  window.NetView = {
    init, render, setHighlight, setFocus, applySearch, centerOnNodes,
    setLabelsDensity, setDisplayMode, setUnitLabels, setCardFields, setCardData, resize, getPositions,
    getViewNodes, getViewEdges, neighborhood,
    getMetrics: () => ({ nodes: graph ? graph.order : 0, edges: graph ? graph.size : 0 }),
    temporalWidth: TEMPORAL_WIDTH,
    // Hook de test (e2e) : déclenche la sélection comme un clic sur le nœud.
    simulateClick: (id) => callbacks.onSelect && callbacks.onSelect(id),
  };
})();
