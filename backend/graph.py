"""
graph.py — Le cœur de l'outil.

À partir des rôles de colonnes, on construit UN graphe maître networkx qui
contient toutes les entités possibles + un nœud-charnière « ouvrage » par ligne.
Ce graphe ne change jamais après construction.

Tout le reste (masquer une couche, changer de pivot, masquer la charnière,
filtrer par année, report/cut des liens) est une *projection* calculée à la
volée — on ne reconstruit jamais le graphe maître.

Modèle :
  - nœud entité   : id = "{colonne}::{valeur}", type = colonne, kind = "entity"
  - nœud ouvrage  : id = "work::{ligne}", kind = "work" (la charnière)
  - arêtes        : entité ── ouvrage  (le graphe maître est biparti)

Projection (report) : on « contracte » les nœuds masqués (charnière et/ou
couches éteintes) — les voisins visibles d'un même groupe masqué se relient
directement entre eux, et le poids de l'arête compte les ouvrages partagés.
Projection (cut)    : on ne garde que les liens entre nœuds restés visibles ;
la carte se déconnecte.
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Any, Iterable

import networkx as nx

from .ingest import ROLE_NODE, ROLE_EDGE, ROLE_ATTRIBUTE, split_cell, parse_year, _normalize_scalar, _is_blank

WORK_TYPE = "__work__"

# Palette par défaut pour les types d'entités. On essaie d'abord un mapping par
# nom (pour de jolis défauts sur des données franco-roumaines), sinon on pioche
# dans un cycle. Rien n'est figé : la couleur encode le *type* (togglable côté
# interface vers la couleur par communauté).
PALETTE_CYCLE = [
    "#7B5BD6",  # violet
    "#1D8A68",  # vert
    "#B8453F",  # rouge / corail
    "#3B6FA8",  # bleu
    "#C07A1A",  # ambre
    "#4F9D8A",  # vert d'eau
    "#A0568C",  # prune
    "#6B8E23",  # olive
    "#C2553B",  # brique
    "#5470B0",  # bleu ardoise
]

NAME_COLOR_HINTS = [
    (("auteur", "author", "écrivain", "ecrivain"), "#7B5BD6"),
    (("traduct", "translator"), "#1D8A68"),
    (("édit", "edit", "maison", "publish"), "#B8453F"),
    (("langue", "language", "lang"), "#3B6FA8"),
    (("genre", "lieu", "ville", "place", "city", "pays"), "#C07A1A"),
]


# Dégradé « ancien → récent » pour la coloration par époque (bleu → ambre).
EPOCH_STOPS = [(0.0, "#3B6FA8"), (0.5, "#9C8E5A"), (1.0, "#C07A1A")]
EPOCH_NEUTRAL = "#C9C3B6"   # nœud sans année connue


def epoch_color(year: float | None, ymin: int | None, ymax: int | None) -> str:
    """Couleur d'un nœud selon son année (dégradé continu ancien→récent)."""
    if year is None or ymin is None or ymax is None or ymax <= ymin:
        return EPOCH_NEUTRAL
    t = max(0.0, min(1.0, (year - ymin) / (ymax - ymin)))
    # Trouve le segment de dégradé contenant t et interpole.
    for i in range(len(EPOCH_STOPS) - 1):
        p0, c0 = EPOCH_STOPS[i]
        p1, c1 = EPOCH_STOPS[i + 1]
        if t <= p1:
            f = 0.0 if p1 == p0 else (t - p0) / (p1 - p0)
            return _lerp_hex(c0, c1, f)
    return EPOCH_STOPS[-1][1]


def _lerp_hex(a: str, b: str, f: float) -> str:
    ca, cb = _hex_rgb(a), _hex_rgb(b)
    return "#" + "".join(f"{round(ca[i] + (cb[i] - ca[i]) * f):02x}" for i in range(3))


def _hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def node_mean_year(data: dict) -> float | None:
    """Année moyenne d'activité d'un nœud (moyenne des années de ses ouvrages
    actifs). Pour un nœud-ouvrage, c'est sa propre année.

    Les années des ouvrages actifs sont déposées sur le nœud projeté par
    `project()` (attribut `work_years`) : on ne reconstruit aucun id de charnière,
    donc ça marche quel que soit son format (fusion `hinge_key` incluse)."""
    if data.get("kind") == "work":
        return data.get("year")
    years = data.get("work_years") or []
    return (sum(years) / len(years)) if years else None


@dataclass
class MasterMeta:
    """Tout ce qu'il faut savoir d'un graphe maître pour le projeter."""
    roles: dict[str, str]
    node_cols: list[str]
    edge_cols: list[str]
    attr_cols: list[str]
    time_col: str | None
    year_min: int | None
    year_max: int | None
    n_works: int
    type_counts: dict[str, int]
    palette: dict[str, str]
    separators: list[str]
    # Nom affiché de la charnière (une ligne) — singulier / pluriel. Réglable.
    unit_singular: str = "objet"
    unit_plural: str = "objets"
    # Colonne définissant l'IDENTITÉ de la charnière : les lignes qui partagent
    # cette valeur fusionnent en une seule charnière (None = une ligne = une charnière).
    hinge_key: str | None = None

    def to_summary(self) -> dict[str, Any]:
        return {
            "node_layers": self.node_cols,
            "edge_cols": self.edge_cols,
            "attr_cols": self.attr_cols,
            "time_col": self.time_col,
            "year_min": self.year_min,
            "year_max": self.year_max,
            "n_works": self.n_works,
            "type_counts": self.type_counts,
            "palette": self.palette,
            "separators": self.separators,
            "unit_singular": self.unit_singular,
            "unit_plural": self.unit_plural,
            "hinge_key": self.hinge_key,
            "n_nodes_total": sum(self.type_counts.values()),
        }


# --------------------------------------------------------------------------
# Construction du graphe maître
# --------------------------------------------------------------------------

def build_master_graph(df, roles: dict[str, str], separators: list[str],
                       time_col: str | None = None,
                       unit_singular: str = "objet",
                       unit_plural: str = "objets",
                       hinge_key: str | None = None) -> tuple[nx.Graph, MasterMeta]:
    """Construit le graphe maître complet à partir des rôles choisis.

    Si `hinge_key` désigne une colonne, les lignes qui partagent la même valeur
    dans cette colonne **fusionnent en une seule charnière** (ex. VO + traduction
    d'une même œuvre). La colonne-clé est alors consommée par l'identité et exclue
    des rôles. Sans clé, une ligne = une charnière (comportement historique).
    """
    # La colonne-clé est réservée à l'identité : on l'exclut des rôles affichés.
    hk = hinge_key if (hinge_key and hinge_key in [str(c) for c in df.columns]) else None
    node_cols = [c for c in df.columns if roles.get(str(c)) == ROLE_NODE and str(c) != hk]
    edge_cols = [c for c in df.columns if roles.get(str(c)) == ROLE_EDGE and str(c) != hk]
    attr_cols = [c for c in df.columns if roles.get(str(c)) == ROLE_ATTRIBUTE and str(c) != hk]

    # Colonne temporelle : celle désignée, sinon la première colonne dont les
    # valeurs ressemblent à des années (toutes colonnes confondues).
    time_col = time_col or _auto_time_col(df)

    G = nx.Graph()
    years: list[int] = []

    for idx, row in df.iterrows():
        # Identité de la charnière : valeur de la clé si fournie, sinon la ligne.
        key_val = _normalize_scalar(row[hk]) if (hk and not _is_blank(row[hk])) else None
        work_id = f"work::key::{key_val}" if key_val is not None else f"work::{idx}"

        # Valeurs-lien de CETTE ligne (ex. son titre).
        edge_values = list(dict.fromkeys(
            _normalize_scalar(row[c]) for c in edge_cols if not _is_blank(row[c])))
        year = parse_year(row[time_col]) if time_col else None
        if year is not None:
            years.append(year)
        row_attrs = {
            str(c): _normalize_scalar(row[c])
            for c in attr_cols if not _is_blank(row[c])
        }

        if work_id in G:
            # Fusion : plusieurs lignes décrivent la même charnière (même œuvre).
            wd = G.nodes[work_id]
            merged_edges = wd["_edge_set"]
            for v in edge_values:
                if v not in merged_edges:
                    merged_edges.append(v)
            wd["label"] = " · ".join(merged_edges) if merged_edges else (key_val or wd["label"])
            if year is not None:
                wd["year"] = year if wd.get("year") is None else min(wd["year"], year)
            for k, v in row_attrs.items():     # attributs : valeurs distinctes cumulées
                if k not in wd["attributes"]:
                    wd["attributes"][k] = v
                elif v not in str(wd["attributes"][k]).split(" · "):
                    wd["attributes"][k] = f"{wd['attributes'][k]} · {v}"
        else:
            label = " · ".join(edge_values) if edge_values else (key_val or f"Ligne {idx + 1}")
            G.add_node(work_id, kind="work", type=WORK_TYPE, label=label, year=year,
                       attributes=dict(row_attrs), row=int(idx), _edge_set=list(edge_values))

        # Relie chaque valeur de chaque colonne-nœud à cette charnière.
        for col in node_cols:
            for value in split_cell(row[col], separators):
                node_id = f"{col}::{value}"
                if node_id not in G:
                    G.add_node(node_id, kind="entity", type=str(col), label=value)
                G.add_edge(node_id, work_id, row=int(idx))

    # `_edge_set` n'a servi qu'à cumuler les valeurs-lien pendant la lecture des
    # lignes (fusion des titres). Une fois le label figé, on le retire : il ne doit
    # pas être porté par les nœuds (ni copié dans chaque projection, ni émis par un
    # futur export brut de tous les attributs).
    for _, wd in G.nodes(data=True):
        wd.pop("_edge_set", None)

    type_counts = _count_types(G)
    palette = assign_palette(node_cols)
    n_works = sum(1 for _, d in G.nodes(data=True) if d.get("kind") == "work")
    meta = MasterMeta(
        roles={str(k): v for k, v in roles.items()},
        node_cols=[str(c) for c in node_cols],
        edge_cols=[str(c) for c in edge_cols],
        attr_cols=[str(c) for c in attr_cols],
        time_col=str(time_col) if time_col is not None else None,
        year_min=min(years) if years else None,
        year_max=max(years) if years else None,
        n_works=n_works,
        type_counts=type_counts,
        palette=palette,
        separators=separators,
        unit_singular=unit_singular,
        unit_plural=unit_plural,
        hinge_key=hk,
    )
    return G, meta


def _auto_time_col(df) -> str | None:
    from .ingest import _looks_like_year_column, _infer_dtype
    for col in df.columns:
        if _looks_like_year_column(col, df[col], _infer_dtype(df[col])):
            return col
    return None


def _count_types(G: nx.Graph) -> dict[str, int]:
    counts: dict[str, int] = {}
    for _, data in G.nodes(data=True):
        if data.get("kind") == "entity":
            counts[data["type"]] = counts.get(data["type"], 0) + 1
    return counts


def assign_palette(node_cols: Iterable[str]) -> dict[str, str]:
    """Une couleur par type d'entité : mapping par nom si possible, sinon cycle."""
    palette: dict[str, str] = {}
    used: set[str] = set()
    cycle = iter(PALETTE_CYCLE)
    for col in node_cols:
        name = str(col).lower()
        chosen = None
        for keys, color in NAME_COLOR_HINTS:
            if any(k in name for k in keys) and color not in used:
                chosen = color
                break
        if chosen is None:
            for c in PALETTE_CYCLE:
                if c not in used:
                    chosen = c
                    break
            else:
                chosen = next(cycle, "#8A857B")
        palette[str(col)] = chosen
        used.add(chosen)
    return palette


# --------------------------------------------------------------------------
# Projection
# --------------------------------------------------------------------------

@dataclass
class ProjectionParams:
    layers: list[str] | None = None          # types d'entités visibles (None = tous)
    link_mode: str = "report"                # "report" | "cut"
    show_hinge: bool = False                  # afficher les nœuds-ouvrages ?
    year_min: int | None = None
    year_max: int | None = None
    pivot: str | None = None                  # type ou id de nœud central (info pour le front)


def project(G: nx.Graph, meta: MasterMeta, params: ProjectionParams) -> nx.Graph:
    """Projette le graphe maître selon les paramètres. Ne modifie jamais G."""
    visible_types = set(params.layers) if params.layers is not None else set(meta.node_cols)

    # 1. Ouvrages actifs selon la fenêtre temporelle. Un ouvrage sans année
    #    reste toujours visible (on ne peut pas le situer dans le temps).
    def work_active(data: dict) -> bool:
        y = data.get("year")
        if y is None:
            return True
        if params.year_min is not None and y < params.year_min:
            return False
        if params.year_max is not None and y > params.year_max:
            return False
        return True

    active_works = {n for n, d in G.nodes(data=True)
                    if d.get("kind") == "work" and work_active(d)}

    # 2. Entités visibles : bon type + reliées à au moins un ouvrage actif.
    visible_entities = set()
    for n, d in G.nodes(data=True):
        if d.get("kind") != "entity" or d["type"] not in visible_types:
            continue
        if any(w in active_works for w in G.neighbors(n)):
            visible_entities.add(n)

    # Nœuds réellement affichés
    visible_nodes = set(visible_entities)
    if params.show_hinge:
        visible_nodes |= active_works

    # 3. Nœuds-ponts (masqués mais qui peuvent relier, en mode report) :
    #    - ouvrages actifs non affichés
    #    - entités de type masqué, reliées à un ouvrage actif
    bridge_nodes: set[str] = set()
    if not params.show_hinge:
        bridge_nodes |= active_works
    for n, d in G.nodes(data=True):
        if d.get("kind") == "entity" and d["type"] not in visible_types:
            if any(w in active_works for w in G.neighbors(n)):
                bridge_nodes.add(n)

    # 4. Construit le graphe projeté.
    P = nx.Graph()
    for n in visible_nodes:
        d = G.nodes[n]
        P.add_node(n, **{k: v for k, v in d.items()})

    # 4a. Arêtes directes entre nœuds visibles (cas charnière affichée : entité──ouvrage).
    for u, v, ed in G.edges(data=True):
        if u in visible_nodes and v in visible_nodes:
            # ne garder que si l'arête concerne un ouvrage actif
            if _edge_touches_active(G, u, v, active_works):
                _bump_edge(P, u, v, 1)

    # 4b. Mode report : contracter les ponts. Chaque composante connexe de
    #     l'induit sur les ponts relie en clique ses nœuds visibles frontières.
    if params.link_mode == "report" and bridge_nodes:
        bridge_sub = G.subgraph(bridge_nodes)
        for component in nx.connected_components(bridge_sub):
            boundary = _visible_boundary(G, component, visible_nodes)
            for a, b in itertools.combinations(sorted(boundary), 2):
                _bump_edge(P, a, b, 1)

    # 5. Mémorise, pour chaque entité visible, ses ouvrages actifs (taille/fiche).
    for n in visible_entities:
        works = [w for w in G.neighbors(n) if w in active_works]
        P.nodes[n]["work_count"] = len(works)
        # Années réelles des ouvrages actifs (pour mean_year : couleur par époque
        # et axe temporel). On stocke les années, pas des numéros de ligne, afin de
        # rester robuste au format d'id de la charnière (fusion `hinge_key` incluse).
        P.nodes[n]["work_years"] = sorted(
            y for w in works if (y := G.nodes[w].get("year")) is not None)
    for n in (visible_nodes & active_works):
        P.nodes[n]["work_count"] = 1

    return P


def _edge_touches_active(G: nx.Graph, u: str, v: str, active_works: set[str]) -> bool:
    """Une arête entité──ouvrage n'est gardée que si son ouvrage est actif."""
    for node in (u, v):
        if G.nodes[node].get("kind") == "work":
            return node in active_works
    return True  # arête entité──entité éventuelle : toujours pertinente


def _visible_boundary(G: nx.Graph, component: set[str], visible_nodes: set[str]) -> set[str]:
    """Nœuds visibles adjacents (dans le maître) à une composante de ponts."""
    boundary: set[str] = set()
    for hidden in component:
        for nb in G.neighbors(hidden):
            if nb in visible_nodes:
                boundary.add(nb)
    return boundary


def _bump_edge(P: nx.Graph, u: str, v: str, w: int) -> None:
    if u == v:
        return
    if P.has_edge(u, v):
        P[u][v]["weight"] += w
    else:
        P.add_edge(u, v, weight=w)


# --------------------------------------------------------------------------
# Détail d'un nœud (pour le panneau de droite)
# --------------------------------------------------------------------------

def entities_by_type(G: nx.Graph, node_id: str,
                     exclude: str | None = None) -> dict[str, list[str]]:
    """Entités voisines d'un nœud, groupées par type → liste de labels.

    Base commune (helper unique) à la carte d'une charnière (`work_card`), à la
    fiche d'un nœud (`node_detail`) et aux « partenaires » d'un ouvrage : un seul
    endroit pour parcourir les voisins, pour qu'ils ne divergent plus.
    """
    out: dict[str, list[str]] = {}
    for nb in G.neighbors(node_id):
        if nb == exclude:
            continue
        nd = G.nodes[nb]
        if nd.get("kind") == "entity":
            out.setdefault(nd["type"], []).append(nd.get("label", nb))
    return out


def work_card(G: nx.Graph, meta: MasterMeta, node_id: str) -> dict[str, str]:
    """Valeurs affichables sur la carte d'une charnière (un livre) : entités liées
    groupées par type, attributs, et l'année. Le front choisit lesquelles montrer.

    Lue sur le graphe **maître** → **invariante par projection** : la carte est la
    fiche complète de la ligne (toutes ses entités, y compris des couches masquées —
    choix délibéré), donc calculable une seule fois et servie par `/cards` au lieu
    d'être réémise à chaque appel `/graph` (cf. balayage du curseur temporel)."""
    d = G.nodes[node_id]
    out: dict[str, str] = {
        t: " · ".join(vals) for t, vals in entities_by_type(G, node_id).items()
    }
    for k, v in (d.get("attributes") or {}).items():
        out[str(k)] = str(v)
    if d.get("year") is not None and meta.time_col:
        out.setdefault(str(meta.time_col), str(d["year"]))
    return out


def all_work_cards(G: nx.Graph, meta: MasterMeta) -> dict[str, dict[str, str]]:
    """Cartes de toutes les charnières, calculées en une passe (servies par /cards)."""
    return {n: work_card(G, meta, n)
            for n, d in G.nodes(data=True) if d.get("kind") == "work"}


def node_detail(G: nx.Graph, meta: MasterMeta, node_id: str,
                params: ProjectionParams) -> dict[str, Any]:
    """Construit la fiche d'un nœud : attributs, voisins par type, ouvrages liés,
    période d'activité. Respecte la fenêtre temporelle courante."""
    if node_id not in G:
        raise KeyError(node_id)
    d = G.nodes[node_id]

    def work_active(w: str) -> bool:
        y = G.nodes[w].get("year")
        if y is None:
            return True
        if params.year_min is not None and y < params.year_min:
            return False
        if params.year_max is not None and y > params.year_max:
            return False
        return True

    if d.get("kind") == "work":
        return {
            "id": node_id, "label": d["label"], "type": WORK_TYPE, "kind": "work",
            "color": "#8A857B",
            "attributes": d.get("attributes", {}),
            "year": d.get("year"),
            "neighbors_by_type": entities_by_type(G, node_id),
            "works": [],
        }

    # Entité : remonte vers ses ouvrages actifs, puis vers les co-entités.
    work_nodes = [w for w in G.neighbors(node_id) if work_active(w)]
    works = []
    neighbors_by_type: dict[str, dict[str, int]] = {}
    years: list[int] = []
    for w in sorted(work_nodes, key=lambda x: G.nodes[x].get("row", 0)):
        wd = G.nodes[w]
        if wd.get("year") is not None:
            years.append(wd["year"])
        works.append({
            "id": w, "label": wd["label"], "year": wd.get("year"),
            "attributes": wd.get("attributes", {}),
            "partners": entities_by_type(G, w, exclude=node_id),
        })
        for nb in G.neighbors(w):
            if nb == node_id:
                continue
            nd = G.nodes[nb]
            if nd.get("kind") != "entity":
                continue
            bucket = neighbors_by_type.setdefault(nd["type"], {})
            bucket[nd["label"]] = bucket.get(nd["label"], 0) + 1

    return {
        "id": node_id,
        "label": d["label"],
        "type": d["type"],
        "kind": "entity",
        "color": meta.palette.get(d["type"], "#8A857B"),
        "attributes": {},
        "work_count": len(works),
        "period": [min(years), max(years)] if years else None,
        "neighbors_by_type": {
            t: [k for k, _ in sorted(v.items(), key=lambda kv: (-kv[1], kv[0]))]
            for t, v in neighbors_by_type.items()
        },
        "works": works,
    }


def initial_positions(G: nx.Graph, scale: float = 10.0) -> dict[str, list[float]]:
    """Positions calculées UNE fois sur le graphe maître (seed déterministe).

    Réutilisées pour toutes les projections et tous les crans temporels → les
    nœuds ne « sautent » pas quand on bouge le curseur. Le front peut affiner
    avec ForceAtlas2, puis renvoie les positions finales pour l'export, ce qui
    garantit que l'image correspond à l'écran.
    """
    if G.number_of_nodes() == 0:
        return {}
    k = 1.0 / max(1.0, (G.number_of_nodes() ** 0.5))
    pos = nx.spring_layout(G, seed=42, k=k, iterations=120)
    return {n: [round(float(xy[0]) * scale, 4), round(float(xy[1]) * scale, 4)]
            for n, xy in pos.items()}
