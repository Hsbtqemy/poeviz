"""
main.py — Application FastAPI : routes + assemblage des modules + service du front.

Pas de base de données : chaque fichier uploadé vit en mémoire le temps de la
session, indexé par un session_id. Le graphe maître est construit une fois à
/configure ; toutes les vues (/graph, /node, /metrics, /export) sont des
projections calculées à la volée.

Lancement :  uvicorn backend.main:app --reload
"""
from __future__ import annotations

import uuid
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

app = FastAPI(title="Cartographie interactive de métadonnées",
              description="Tableur Excel → réseau d'entités explorable",
              version="1.0.0")

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
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


SESSIONS: dict[str, Session] = {}


def get_session(session_id: str) -> Session:
    session = SESSIONS.get(session_id)
    if session is None:
        raise HTTPException(404, "Session inconnue ou expirée. Rechargez un fichier.")
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


class ExportBody(BaseModel):
    session_id: str
    kind: str = "image"            # image | gexf | csv_nodes | csv_edges | metrics
    format: str = "png"            # png|svg|pdf  /  csv|xlsx
    dimensions: str = "pleine_page"
    labels: str = "pivots"
    title: str | None = None
    view: dict[str, Any] = {}      # {nodes:[...], edges:[...]} envoyés par le front
    panels: list[dict[str, Any]] | None = None   # petits multiples : une vue par période


# --------------------------------------------------------------------------
# Projection : paramètres communs + construction de la « vue » canonique
# --------------------------------------------------------------------------

def parse_projection(layers: str | None, link_mode: str, show_hinge: bool,
                     year_min: int | None, year_max: int | None,
                     pivot: str | None) -> graph.ProjectionParams:
    layer_list = None
    if layers is not None and layers != "":
        layer_list = [s for s in layers.split(",") if s]
    return graph.ProjectionParams(
        layers=layer_list, link_mode=link_mode, show_hinge=show_hinge,
        year_min=year_min, year_max=year_max, pivot=pivot or None,
    )


def build_view(session: Session, params: graph.ProjectionParams,
               color_by: str = "type", size_by: str = "degree") -> dict[str, Any]:
    """Projette + analyse + assemble nœuds/arêtes prêts pour Sigma (et l'export)."""
    G, meta = session.master, session.meta
    P = graph.project(G, meta, params)
    metrics = analysis.compute_metrics(P, size_by=size_by)
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
        my = graph.node_mean_year(G, n, d)
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
    content = await file.read()
    try:
        dataset = ingest.read_workbook(content)
    except Exception as exc:
        raise HTTPException(400, f"Lecture impossible : {exc}")
    session_id = uuid.uuid4().hex[:12]
    SESSIONS[session_id] = Session(dataset=dataset)
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
    SESSIONS[session_id] = Session(dataset=dataset)
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
    return {
        "session_id": session_id,
        "sheet": ds.active_sheet,
        "n_rows": len(df),
        "time_col": str(time_col) if time_col is not None else None,
        "separators": session.separators,
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

    node_cols = [c for c, r in session.roles.items() if r == ingest.ROLE_NODE]
    if not node_cols:
        raise HTTPException(
            400, "Aucune colonne en rôle « nœud ». Choisissez au moins un type "
                 "d'entité à afficher (ex. Auteur, Traducteur).")

    G, meta = graph.build_master_graph(df, session.roles, session.separators,
                                       time_col=body.time_col)
    session.master = G
    session.meta = meta
    session.positions = graph.initial_positions(G)
    return {"session_id": body.session_id, "summary": meta.to_summary()}


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
) -> dict[str, Any]:
    session = get_session(session_id)
    require_master(session)
    params = parse_projection(layers, link_mode, show_hinge, year_min, year_max, pivot)
    return build_view(session, params, color_by=color_by, size_by=size_by)


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


@app.post("/export")
def post_export(body: ExportBody):
    session = get_session(body.session_id)
    require_master(session)
    nodes = body.view.get("nodes", [])
    edges = body.view.get("edges", [])
    kind = body.kind
    if kind != "small_multiples" and not nodes:
        raise HTTPException(400, "Rien à exporter : la vue est vide.")

    try:
        if kind == "small_multiples":
            data, ctype = export.render_small_multiples(
                body.panels or [], fmt=body.format, title=body.title)
            ext = body.format.lower()
        elif kind == "image":
            data, ctype = export.render_image(
                nodes, edges, fmt=body.format, dimensions=body.dimensions,
                labels=body.labels, title=body.title)
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
