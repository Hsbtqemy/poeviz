"""
main.py — Application FastAPI : routes + assemblage des modules + service du front.

Pas de base de données : chaque fichier uploadé vit en mémoire le temps de la
session, indexé par un session_id. Le graphe maître est construit une fois à
/configure ; toutes les vues (/graph, /node, /metrics, /export) sont des
projections calculées à la volée.

Lancement :  uvicorn backend.main:app --reload
"""
from __future__ import annotations

import json
import os
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, UploadFile, File, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import io

from . import ingest, graph, analysis, export

# Réglages de garde-fou (faciles à éditer).
MAX_SESSIONS = 12                 # plafond de sessions en mémoire (éviction LRU)
MAX_UPLOAD_MB = 25                # taille max d'un .xlsx accepté
MAX_METRICS_CACHE = 128           # vues mémorisées par session (cache des métriques)

# Origines autorisées (CORS). Défaut « * » (pratique en local) ; en production,
# définir ALLOWED_ORIGINS sur l'origine publique, séparées par des virgules, p. ex.
# `ALLOWED_ORIGINS=https://poeviz.edito-revue.fr`. (Le front et l'API sont servis sur
# la même origine → le CORS est surtout du durcissement défensif.)
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")
                   if o.strip()] or ["*"]

app = FastAPI(title="Cartographie interactive de métadonnées",
              description="Tableur Excel → réseau d'entités explorable",
              version="1.0.0")

app.add_middleware(
    CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


# --------------------------------------------------------------------------
# Stockage de session (en mémoire)
# --------------------------------------------------------------------------

@dataclass
class Session:
    dataset: ingest.Dataset
    profiles: dict[str, list[ingest.ColumnProfile]] = field(default_factory=dict)
    roles: dict[str, str] = field(default_factory=dict)
    separators: list[str] = field(default_factory=lambda: list(ingest.DEFAULT_SEPARATORS))
    master: Any = None            # nx.Graph
    meta: graph.MasterMeta | None = None
    positions: dict[str, list[float]] = field(default_factory=dict)
    # Cache des métriques par signature de projection (perf : évite de relancer
    # Louvain/centralités à chaque cran de curseur ou changement de couleur).
    metrics_cache: dict[Any, Any] = field(default_factory=OrderedDict)


# Sessions en mémoire, avec éviction LRU (pas de base de données ; on plafonne
# pour ne pas accumuler indéfiniment des graphes en RAM).
SESSIONS: "OrderedDict[str, Session]" = OrderedDict()


def store_session(session_id: str, session: Session) -> None:
    SESSIONS[session_id] = session
    SESSIONS.move_to_end(session_id)
    while len(SESSIONS) > MAX_SESSIONS:
        SESSIONS.popitem(last=False)   # évince la session la plus ancienne


def get_session(session_id: str) -> Session:
    session = SESSIONS.get(session_id)
    if session is None:
        raise HTTPException(404, "Session inconnue ou expirée. Rechargez un fichier.")
    SESSIONS.move_to_end(session_id)   # « touche » la session (LRU)
    return session


def require_master(session: Session) -> None:
    if session.master is None or session.meta is None:
        raise HTTPException(400, "Graphe non configuré. Appelez /configure d'abord.")


# --------------------------------------------------------------------------
# Modèles de requête
# --------------------------------------------------------------------------

class ConfigureBody(BaseModel):
    session_id: str
    roles: dict[str, str]
    sheet: str | None = None
    separators: list[str] | None = None
    time_col: str | None = None
    unit_singular: str | None = None   # nom d'une ligne (charnière), au singulier
    unit_plural: str | None = None     # … et au pluriel
    hinge_key: str | None = None       # colonne regroupant les lignes en une charnière


class ExportBody(BaseModel):
    session_id: str
    kind: str = "image"            # image | gexf | csv_nodes | csv_edges | metrics
    format: str = "png"            # png|svg|pdf  /  csv|xlsx
    dimensions: str = "pleine_page"
    labels: str = "pivots"
    title: str | None = None
    view: dict[str, Any] = {}      # {nodes:[...], edges:[...]} envoyés par le front
    panels: list[dict[str, Any]] | None = None   # petits multiples : une vue par période
    time_axis: dict[str, Any] | None = None      # réseau temporel : axe des années à dessiner
    unit_singular: str = "objet"   # nom d'une ligne (charnière) pour les libellés
    unit_plural: str = "objets"


# --------------------------------------------------------------------------
# Projection : paramètres communs + construction de la « vue » canonique
# --------------------------------------------------------------------------

def parse_projection(layers: str | None, link_mode: str, show_hinge: bool,
                     year_min: int | None, year_max: int | None,
                     pivot: str | None,
                     connectors: str | None = None,
                     focus: str | None = None, hops: int = 1,
                     degree_min: int = 0,
                     facets: dict[str, list[str]] | None = None) -> graph.ProjectionParams:
    layer_list = None
    if layers is not None and layers != "":
        layer_list = [x for x in layers.split(",") if x]
    # Connecteurs : ABSENT (None) = seuls les types NŒUD masqués relient (rétro-compat).
    # PRÉSENT même vide ("") = liste explicite → seuls ces types relient, les autres
    # types masqués sont exclus (mode lentille piloté par le front).
    connector_list = None
    if connectors is not None:
        connector_list = [x for x in connectors.split(",") if x]
    return graph.ProjectionParams(
        layers=layer_list, link_mode=link_mode, show_hinge=show_hinge,
        year_min=year_min, year_max=year_max, pivot=pivot or None,
        connector_layers=connector_list,
        focus=focus or None, hops=max(1, min(3, hops)),     # focalisation (ego), 1..3 sauts
        degree_min=max(0, degree_min),                       # filtre « degré minimum »
        facets=facets or None,                               # filtre par facettes (attributs)
    )


def build_view(session: Session, params: graph.ProjectionParams,
               color_by: str = "type", size_by: str = "degree") -> dict[str, Any]:
    """Projette + analyse + assemble nœuds/arêtes prêts pour Sigma (et l'export)."""
    G, meta = session.master, session.meta
    P = graph.project(G, meta, params)

    # Focalisation (ego) : restreindre la vue au voisinage du nœud focal (sous-graphe),
    # pour que métriques / force / MDS se recalculent LOCALEMENT. focus hors-vue (filtré
    # par les couches ou la fenêtre temporelle) → ignoré, signalé via focus_dropped.
    focus_dropped = False
    if params.focus:
        if params.focus in P:
            P = P.subgraph(graph.ego_nodes(P, params.focus, params.hops)).copy()
        else:
            focus_dropped = True

    # Filtre de lisibilité « degré minimum » : masque les nœuds peu reliés DANS la
    # projection (après focalisation). Les métriques se recalculent donc sur la vue filtrée.
    if params.degree_min > 0:
        P = graph.filter_min_degree(P, params.degree_min)

    # Métriques : coûteuses (Louvain + centralités). Elles ne dépendent que de la
    # PROJECTION (couches/liens/charnière/années/focalisation/degré min) + size_by, pas
    # de la couleur. On les mémorise → changer la couleur ou revenir sur une vue est instantané.
    cache_key = (
        tuple(sorted(params.layers)) if params.layers is not None else None,
        tuple(sorted(params.connector_layers)) if params.connector_layers is not None else None,
        params.link_mode, params.show_hinge, params.year_min, params.year_max, size_by,
        params.focus, params.hops, params.degree_min,
        tuple(sorted((c, tuple(sorted(v))) for c, v in params.facets.items()))
        if params.facets else None,
    )
    cache = session.metrics_cache
    metrics = cache.get(cache_key)
    if metrics is None:
        metrics = analysis.compute_metrics(P, size_by=size_by)
        if len(cache) >= MAX_METRICS_CACHE:
            cache.clear()                 # garde-fou mémoire (cache borné)
        cache[cache_key] = metrics
    per_node = metrics["nodes"]

    # Échelle des tailles à partir de la centralité choisie.
    size_key = metrics["summary"]["size_by"]
    raw = {n: per_node[n][size_key] for n in P.nodes()}
    lo = min(raw.values()) if raw else 0.0
    hi = max(raw.values()) if raw else 1.0
    span = (hi - lo) or 1.0

    nodes_out = []
    for n, d in P.nodes(data=True):
        nm = per_node[n]
        size = 5.0 + 17.0 * ((raw[n] - lo) / span)
        my = graph.node_mean_year(d)
        if color_by == "epoch":
            color = graph.epoch_color(my, meta.year_min, meta.year_max)
        elif color_by == "community":
            color = analysis.community_color(nm["community"])
        elif d.get("kind") == "work":
            color = "#8A857B"
        else:
            color = meta.palette.get(d.get("type"), "#8A857B")
        pos = session.positions.get(n, [0.0, 0.0])
        nodes_out.append({
            "id": n,
            "label": d.get("label", n),
            "type": d.get("type"),
            "kind": d.get("kind"),
            "color": color,
            "size": round(size, 2),
            "mean_year": round(my, 1) if my is not None else None,
            "x": pos[0],
            "y": pos[1],
            "degree": nm["degree"],
            "degree_raw": nm["degree_raw"],
            "betweenness": nm["betweenness"],
            "eigenvector": nm["eigenvector"],
            "community": nm["community"],
            "work_count": d.get("work_count", 0),
        })

    edges_out = [
        {"source": u, "target": v, "weight": ed.get("weight", 1)}
        for u, v, ed in P.edges(data=True)
    ]
    return {
        "nodes": nodes_out,
        "edges": edges_out,
        "summary": metrics["summary"],
        "palette": meta.palette,
        "node_layers": meta.node_cols,
        "color_by": color_by,
        "size_by": size_key,
        "focus_dropped": focus_dropped,
        "epoch_legend": {
            "year_min": meta.year_min, "year_max": meta.year_max,
            "stops": [{"pos": p, "color": c} for p, c in graph.EPOCH_STOPS],
        } if color_by == "epoch" else None,
    }


# --------------------------------------------------------------------------
# Routes API
# --------------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "sessions": len(SESSIONS), "louvain": analysis._HAS_LOUVAIN}


@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> dict[str, Any]:
    name = (file.filename or "").lower()
    if not name.endswith((".xlsx", ".xlsm")):
        raise HTTPException(400, "Déposez un fichier .xlsx pour commencer.")
    # Lecture plafonnée : on s'arrête dès qu'on dépasse la limite (évite l'OOM
    # sur un fichier énorme avant même de le parser).
    limit = MAX_UPLOAD_MB * 1024 * 1024
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise HTTPException(413, f"Fichier trop volumineux (limite : {MAX_UPLOAD_MB} Mo).")
        chunks.append(chunk)
    try:
        dataset = ingest.read_workbook(b"".join(chunks))
    except Exception as exc:
        raise HTTPException(400, f"Lecture impossible : {exc}")
    session_id = uuid.uuid4().hex[:12]
    store_session(session_id, Session(dataset=dataset))
    return {
        "session_id": session_id,
        "sheets": dataset.sheets,
        "active_sheet": dataset.active_sheet,
        "filename": file.filename,
    }


@app.get("/demo")
def demo() -> dict[str, Any]:
    """Charge le fichier de démonstration fourni dans une nouvelle session."""
    demo_path = Path(__file__).resolve().parent.parent / "data" / "traductions_demo.xlsx"
    if not demo_path.exists():
        raise HTTPException(404, "Fichier de démonstration introuvable.")
    dataset = ingest.read_workbook(demo_path.read_bytes())
    session_id = uuid.uuid4().hex[:12]
    store_session(session_id, Session(dataset=dataset))
    return {
        "session_id": session_id,
        "sheets": dataset.sheets,
        "active_sheet": dataset.active_sheet,
        "filename": "traductions_demo.xlsx",
    }


@app.get("/profile")
def profile(session_id: str, sheet: str | None = None) -> dict[str, Any]:
    session = get_session(session_id)
    ds = session.dataset
    if sheet and sheet in ds.frames:
        ds.active_sheet = sheet
    df = ds.df
    if df.shape[1] == 0:
        raise HTTPException(400, "Cette feuille ne contient aucune colonne exploitable.")
    profiles = ingest.profile_dataframe(df, session.separators)
    session.profiles[ds.active_sheet] = profiles
    time_col = graph._auto_time_col(df)
    unit_s, unit_p = ingest.default_unit_label(ds.active_sheet)
    return {
        "session_id": session_id,
        "sheet": ds.active_sheet,
        "n_rows": len(df),
        "time_col": str(time_col) if time_col is not None else None,
        "separators": session.separators,
        "suggested_unit": {"singular": unit_s, "plural": unit_p},
        "columns": [p.to_dict() for p in profiles],
    }


@app.post("/configure")
def configure(body: ConfigureBody) -> dict[str, Any]:
    session = get_session(body.session_id)
    ds = session.dataset
    if body.sheet and body.sheet in ds.frames:
        ds.active_sheet = body.sheet
    df = ds.df
    if body.separators is not None:
        session.separators = body.separators
    session.roles = {str(k): v for k, v in body.roles.items()}
    hinge_key = (body.hinge_key or "").strip() or None

    # Une colonne ne peut pas être à la fois clé de regroupement ET entité : la clé
    # est consommée par l'identité de la charnière. On compte les nœuds RÉELS (hors clé).
    node_cols = [c for c, r in session.roles.items()
                 if r == ingest.ROLE_NODE and c != hinge_key]
    if not node_cols:
        if hinge_key and session.roles.get(hinge_key) == ingest.ROLE_NODE:
            raise HTTPException(
                400, f"La colonne « {hinge_key} » sert à regrouper les lignes : elle "
                     "ne peut pas être en même temps un type d'entité affiché. Mettez "
                     "au moins une AUTRE colonne en rôle « nœud » (ex. Traducteur, "
                     "Éditeur), ou choisissez une autre colonne de regroupement.")
        raise HTTPException(
            400, "Aucune colonne en rôle « nœud ». Choisissez au moins un type "
                 "d'entité à afficher (ex. Auteur, Traducteur).")

    # Nom de la charnière : le singulier suffit, le pluriel est dérivé. On retombe
    # sur la suggestion liée au nom de feuille si rien n'est fourni.
    def_s, def_p = ingest.default_unit_label(ds.active_sheet)
    typed_s = (body.unit_singular or "").strip()
    if typed_s:
        unit_s = typed_s
        unit_p = (body.unit_plural or "").strip() or ingest.pluralize_fr(typed_s)
    else:
        unit_s, unit_p = def_s, def_p

    G, meta = graph.build_master_graph(df, session.roles, session.separators,
                                       time_col=body.time_col,
                                       unit_singular=unit_s, unit_plural=unit_p,
                                       hinge_key=hinge_key)
    session.master = G
    session.meta = meta
    session.positions = graph.initial_positions(G)
    session.metrics_cache.clear()      # nouveau graphe → cache de métriques obsolète
    summary = meta.to_summary()
    # Colonnes filtrables (toutes activables) ; les valeurs se chargent via /facet-values.
    summary["filter_cols"] = graph.filter_columns(meta)
    return {"session_id": body.session_id, "summary": summary}


@app.get("/facet-values")
def facet_values(session_id: str, col: str) -> dict[str, Any]:
    """Valeurs distinctes d'une colonne (labels d'entités), triées — pour le volet de
    filtres, chargées à la demande. `truncated` = colonne quasi-unique tronquée (le
    volet invite alors à affiner par la recherche)."""
    session = get_session(session_id)
    require_master(session)
    values, truncated = graph.column_values(session.master, col)
    return {"col": col, "values": values, "truncated": truncated}


@app.get("/graph")
def get_graph(
    session_id: str,
    layers: str | None = None,
    link_mode: str = "report",
    show_hinge: bool = False,
    color_by: str = "type",
    size_by: str = "degree",
    pivot: str | None = None,
    year_min: int | None = None,
    year_max: int | None = None,
    connectors: str | None = None,
    focus: str | None = None,
    hops: int = 1,
    degree_min: int = 0,
    facets: str | None = None,
) -> dict[str, Any]:
    session = get_session(session_id)
    require_master(session)
    # Facettes : objet {colonne: [valeurs]} encodé en JSON (URL-encodé). Malformé → ignoré.
    facet_dict: dict[str, list[str]] | None = None
    if facets:
        try:
            parsed = json.loads(facets)
            if isinstance(parsed, dict):
                # On garde les listes VIDES (colonne tout décoché = rien gardé) ; seules
                # les colonnes absentes du dict ne contraignent pas (cf. works_passing_facets).
                facet_dict = {str(k): [str(x) for x in v]
                              for k, v in parsed.items() if isinstance(v, list)} or None
        except (ValueError, TypeError):
            facet_dict = None
    params = parse_projection(layers, link_mode, show_hinge, year_min, year_max,
                              pivot, connectors, focus, hops, degree_min, facet_dict)
    return build_view(session, params, color_by=color_by, size_by=size_by)


@app.get("/edge")
def get_edge(
    session_id: str,
    source: str,
    target: str,
    year_min: int | None = None,
    year_max: int | None = None,
) -> dict[str, Any]:
    """Explique pourquoi deux nœuds sont reliés (ouvrages communs + intermédiaires
    partagés) — pour dé-anonymiser une arête au survol."""
    session = get_session(session_id)
    require_master(session)
    params = graph.ProjectionParams(year_min=year_min, year_max=year_max)
    try:
        return graph.edge_detail(session.master, session.meta, source, target, params)
    except KeyError:
        raise HTTPException(404, "Arête introuvable dans le graphe.")


@app.get("/cards")
def get_cards(session_id: str) -> dict[str, dict[str, str]]:
    """Cartes de tous les nœuds — charnières (valeurs de la ligne) ET entités (profil
    agrégé : co-entités, attributs, période). Invariantes par projection ; le front
    les récupère une fois et les réutilise (plutôt qu'à chaque cran du curseur)."""
    session = get_session(session_id)
    require_master(session)
    return graph.all_node_cards(session.master, session.meta)


@app.get("/timeline")
def timeline(session_id: str) -> dict[str, Any]:
    """Compte d'ouvrages par année sur le graphe MAÎTRE (indépendant des filtres
    de couches) — pour l'histogramme/frise sous le curseur temporel."""
    session = get_session(session_id)
    require_master(session)
    counts: dict[int, int] = {}
    for _, d in session.master.nodes(data=True):
        if d.get("kind") == "work":
            y = d.get("year")
            if y is not None:
                counts[y] = counts.get(y, 0) + 1
    return {
        "year_min": session.meta.year_min,
        "year_max": session.meta.year_max,
        "counts": [{"year": y, "count": counts[y]} for y in sorted(counts)],
    }


@app.get("/chronology")
def chronology(session_id: str, pivot_type: str | None = None,
               color_attr: str | None = None) -> dict[str, Any]:
    """Données pour la vue Chronologie : une entité du type pivot par ligne,
    ses ouvrages placés dans le temps. Couvre tout l'historique (indépendant du
    curseur). Les points peuvent être colorés par un attribut au choix."""
    session = get_session(session_id)
    require_master(session)
    G, meta = session.master, session.meta
    ptype = pivot_type if (pivot_type in meta.node_cols) else (meta.node_cols[0] if meta.node_cols else None)
    if ptype is None:
        raise HTTPException(400, "Aucun type d'entité disponible pour la chronologie.")
    if color_attr not in (meta.attr_cols or []):
        color_attr = None

    entities = []
    values: list[str] = []
    for n, d in G.nodes(data=True):
        if d.get("kind") != "entity" or d.get("type") != ptype:
            continue
        works = []
        for w in G.neighbors(n):
            wd = G.nodes[w]
            if wd.get("kind") != "work" or wd.get("year") is None:
                continue
            cv = wd.get("attributes", {}).get(color_attr) if color_attr else None
            if cv is not None and cv not in values:
                values.append(cv)
            works.append({
                "year": wd["year"], "title": wd.get("label", ""),
                "color_value": cv, "attributes": wd.get("attributes", {}),
            })
        if not works:
            continue
        works.sort(key=lambda x: x["year"])
        entities.append({
            "id": n, "label": d.get("label", n),
            "first": works[0]["year"], "last": works[-1]["year"], "works": works,
        })

    # Couleur des points : par valeur d'attribut, sinon couleur du type pivot.
    color_map = {v: graph.PALETTE_CYCLE[i % len(graph.PALETTE_CYCLE)]
                 for i, v in enumerate(sorted(values, key=str.lower))}
    default_color = meta.palette.get(ptype, "#1D8A68")
    for e in entities:
        for w in e["works"]:
            w["color"] = color_map.get(w["color_value"], default_color)
    # Lignes triées par année du premier ouvrage (plus récent en haut).
    entities.sort(key=lambda e: (e["first"], e["label"]), reverse=True)

    return {
        "pivot_type": ptype, "color_attr": color_attr,
        "year_min": meta.year_min, "year_max": meta.year_max,
        "color_map": color_map, "default_color": default_color,
        "attr_cols": meta.attr_cols, "entities": entities,
    }


@app.get("/node/{node_id:path}")
def get_node(
    node_id: str,
    session_id: str,
    year_min: int | None = None,
    year_max: int | None = None,
) -> dict[str, Any]:
    session = get_session(session_id)
    require_master(session)
    params = graph.ProjectionParams(year_min=year_min, year_max=year_max)
    try:
        return graph.node_detail(session.master, session.meta, node_id, params)
    except KeyError:
        raise HTTPException(404, "Nœud introuvable dans le graphe.")


@app.get("/metrics")
def get_metrics(
    session_id: str,
    layers: str | None = None,
    link_mode: str = "report",
    show_hinge: bool = False,
    size_by: str = "degree",
    year_min: int | None = None,
    year_max: int | None = None,
) -> dict[str, Any]:
    session = get_session(session_id)
    require_master(session)
    params = parse_projection(layers, link_mode, show_hinge, year_min, year_max, None)
    view = build_view(session, params, size_by=size_by)
    return {"summary": view["summary"], "nodes": view["nodes"]}


@app.get("/axes")
def get_axes(
    session_id: str,
    dims: str | None = None,
    year_min: int | None = None,
    year_max: int | None = None,
) -> dict[str, Any]:
    """Agrégat d'un (ou plusieurs) attribut(s) par nœud, sur ses ouvrages actifs —
    brique des futures dispositions « par attribut » (axes) et « par similarité ».
    Inerte : /graph et la vue par défaut ne l'appellent pas. `available` liste les
    dimensions agrégeables (avec leur nature numérique/catégorielle) ; `values`
    renvoie `{dim: {node_id: valeur}}` pour les dimensions demandées via `dims`."""
    session = get_session(session_id)
    require_master(session)
    meta = session.meta
    available = [
        {"col": e["col"], "kind": e.get("kind", "categorical"),
         "activable": e.get("activable", False)}
        for e in meta.layer_cols
    ]
    dim_list = [x for x in (dims or "").split(",") if x]
    params = graph.ProjectionParams(year_min=year_min, year_max=year_max)
    values = graph.axis_values(session.master, meta, params, dim_list)
    return {"available": available, "values": values}


@app.get("/similar")
def get_similar(
    session_id: str,
    dims: str | None = None,
    threshold: float = 0.5,
    year_min: int | None = None,
    year_max: int | None = None,
) -> dict[str, Any]:
    """Arêtes latentes de similarité d'attributs (cosinus, par type) — la « force »
    de la disposition par similarité (T4). Le front les injecte invisiblement dans
    ForceAtlas2 pour rapprocher les nœuds qui se ressemblent. `dims` = attributs
    catégoriels pris en compte ; vide → aucune arête."""
    session = get_session(session_id)
    require_master(session)
    dim_list = [x for x in (dims or "").split(",") if x]
    params = graph.ProjectionParams(year_min=year_min, year_max=year_max)
    edges = graph.similarity_edges(session.master, session.meta, params, dim_list,
                                   threshold=threshold)
    return {"edges": edges}


@app.get("/mds")
def get_mds(
    session_id: str,
    dims: str | None = None,
    layers: str | None = None,
    year_min: int | None = None,
    year_max: int | None = None,
) -> dict[str, Any]:
    """Positions de la disposition « similarité (MDS) » (T5) : embedding 2D où la
    distance ≈ dissimilarité d'attributs. `layers` = types d'entités à embarquer
    (visibles) ; `dims` vide → toutes les colonnes catégorielles. `{positions:{id:[x,y]}}`."""
    session = get_session(session_id)
    require_master(session)
    dim_list = [x for x in (dims or "").split(",") if x]
    layer_list = [x for x in layers.split(",") if x] if layers is not None else None
    params = graph.ProjectionParams(layers=layer_list, year_min=year_min, year_max=year_max)
    positions = graph.mds_positions(session.master, session.meta, params, dim_list)
    return {"positions": positions}


@app.post("/export")
def post_export(body: ExportBody):
    session = get_session(body.session_id)
    require_master(session)
    nodes = body.view.get("nodes", [])
    edges = body.view.get("edges", [])
    kind = body.kind
    if kind not in ("small_multiples", "chronology") and not nodes:
        raise HTTPException(400, "Rien à exporter : la vue est vide.")

    try:
        if kind == "small_multiples":
            data, ctype = export.render_small_multiples(
                body.panels or [], fmt=body.format, title=body.title,
                unit_singular=body.unit_singular, unit_plural=body.unit_plural)
            ext = body.format.lower()
        elif kind == "chronology":
            data, ctype = export.render_chronology(
                body.view or {}, fmt=body.format, title=body.title,
                unit_singular=body.unit_singular, unit_plural=body.unit_plural)
            ext = body.format.lower()
        elif kind == "image":
            # On injecte le nom de l'unité dans l'axe temporel pour le libellé.
            time_axis = body.time_axis
            if time_axis is not None:
                time_axis = {**time_axis, "unit_plural": body.unit_plural}
            data, ctype = export.render_image(
                nodes, edges, fmt=body.format, dimensions=body.dimensions,
                labels=body.labels, title=body.title, time_axis=time_axis)
            ext = body.format.lower()
        elif kind == "gexf":
            data, ctype, ext = export.build_gexf(nodes, edges), "application/gexf+xml", "gexf"
        elif kind == "csv_nodes":
            data, ctype, ext = export.nodes_csv(nodes), "text/csv", "csv"
        elif kind == "csv_edges":
            data, ctype, ext = export.edges_csv(edges), "text/csv", "csv"
        elif kind == "metrics":
            if body.format.lower() == "xlsx":
                data = export.metrics_xlsx(nodes)
                ctype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                ext = "xlsx"
            else:
                data, ctype, ext = export.metrics_csv(nodes), "text/csv", "csv"
        else:
            raise HTTPException(400, f"Type d'export inconnu : {kind}")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    filename = f"cartographie_{kind}.{ext}"
    return StreamingResponse(
        io.BytesIO(data), media_type=ctype,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# --------------------------------------------------------------------------
# Service du frontend statique (monté en dernier pour ne pas masquer l'API)
# --------------------------------------------------------------------------

if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


# --------------------------------------------------------------------------
# Point d'entrée serveur (déploiement VPS)
# --------------------------------------------------------------------------

def run() -> None:
    """Lance Uvicorn en lisant l'hôte et le port depuis l'environnement.

    Permet de placer l'app derrière un reverse-proxy (VPS) sans toucher au code :
    `HOST=0.0.0.0 PORT=8000 python -m backend.main`. Défaut volontairement local
    (`127.0.0.1`) → on n'expose jamais l'interface publique par accident.
    NB : état en mémoire → garder UN seul process (pas de workers multiples)."""
    import uvicorn
    uvicorn.run(
        app,
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
    )


if __name__ == "__main__":
    run()
