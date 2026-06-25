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
import math
from dataclasses import dataclass, field
from typing import Any, Iterable

import networkx as nx
import numpy as np

from .ingest import (ROLE_NODE, ROLE_EDGE, ROLE_ATTRIBUTE, ROLE_IGNORE, split_cell,
                     parse_year, _normalize_scalar, _is_blank, _is_number)

WORK_TYPE = "__work__"

# Amorce de positions (cf. initial_positions) : spring_layout est en O(n²)/itération.
# Au-delà de MAX_SPRING_NODES on l'évite (amorce aléatoire) ; en deçà, le nombre
# d'itérations est plafonné par SPRING_BUDGET (≈ n²·itérations) pour borner le temps.
MAX_SPRING_NODES = 1200
SPRING_BUDGET = 25_000_000

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
    # Spécification du panneau de couches (symétrie complète) : une entrée par
    # colonne non-ignorée — {col, role, default, n_unique, activable, warn}.
    layer_cols: list[dict[str, Any]] = field(default_factory=list)

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
            "layer_cols": self.layer_cols,
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
    role_of = {str(c): roles.get(str(c), ROLE_IGNORE) for c in df.columns}
    node_cols = [c for c in df.columns if role_of[str(c)] == ROLE_NODE and str(c) != hk]
    edge_cols = [c for c in df.columns if role_of[str(c)] == ROLE_EDGE and str(c) != hk]
    attr_cols = [c for c in df.columns if role_of[str(c)] == ROLE_ATTRIBUTE and str(c) != hk]

    # Symétrie complète : TOUTE colonne non-ignorée (hors clé) peut devenir nœud ou
    # connecteur dans le panneau. On crée donc ses nœuds dans le maître — « hors-graphe »
    # par défaut sauf les colonnes-NŒUD. `distinct` sert au plafond (perf) et à
    # l'avertissement « quasi-unique » côté interface.
    distinct: dict[str, int] = {}
    graph_cols = []
    for c in df.columns:
        sc = str(c)
        if sc == hk or role_of[sc] == ROLE_IGNORE:
            continue
        distinct[sc] = _distinct_count(df, c, role_of[sc], separators, MAX_NODE_VALUES)
        if 2 <= distinct[sc] <= MAX_NODE_VALUES:
            graph_cols.append(c)
    graph_col_set = {str(c) for c in graph_cols}
    # Un attribut devenu nœud apparaît déjà comme voisin de la charnière : on ne le
    # recopie pas en « attribut » de fiche (évite le doublon). On ne garde en
    # attributs que les colonnes-info NON activées comme nœuds (ex. trop de valeurs).
    attr_only_cols = [c for c in attr_cols if str(c) not in graph_col_set]

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
            for c in attr_only_cols if not _is_blank(row[c])
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

        # Relie chaque valeur de chaque colonne activable à cette charnière (toutes
        # colonnes non-ignorées : elles pourront être affichées ou relier au choix).
        for col in graph_cols:
            for value in _col_values(row[col], role_of[str(col)], separators):
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
    palette = assign_palette(graph_cols)        # une couleur par type activable
    n_works = sum(1 for _, d in G.nodes(data=True) if d.get("kind") == "work")

    # Spécification du panneau de couches : une entrée par colonne non-ignorée, avec
    # son état par défaut (Nœud si rôle nœud, sinon Hors-graphe), son activabilité
    # (sous le plafond), un drapeau « quasi-unique » (deviendrait des nœuds isolés)
    # et sa nature (numérique/catégoriel) — utile aux dispositions « par attribut ».
    tc = str(time_col) if time_col is not None else None
    layer_cols = []
    for c in df.columns:
        sc = str(c)
        if sc == hk or role_of[sc] == ROLE_IGNORE:
            continue
        nu = distinct[sc]
        activable = 2 <= nu <= MAX_NODE_VALUES
        layer_cols.append({
            "col": sc,
            "role": role_of[sc],
            "default": "node" if role_of[sc] == ROLE_NODE else "off",
            "n_unique": nu,
            "activable": activable,
            "warn": bool(activable and n_works and (nu / n_works) >= 0.9),
            "kind": "numeric" if (sc == tc or _is_numeric_col(df, c)) else "categorical",
        })

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
        layer_cols=layer_cols,
    )
    return G, meta


# Plafond de valeurs distinctes pour qu'une colonne soit activable comme nœud. Ce
# n'est plus qu'un garde-fou contre les colonnes pathologiques (des milliers de
# valeurs quasi-uniques) : les positions/métriques passent désormais à l'échelle, et
# l'utilité réelle d'une colonne-nœud est jugée par son RATIO d'unicité (drapeau
# « nœuds isolés » si ratio ≥ 0,9), pas par un compte absolu serré. Des entités réelles
# (traducteurs, lieux…) dépassent facilement quelques centaines sur de vraies bases.
MAX_NODE_VALUES = 2000


def _col_values(cell, role, separators) -> list[str]:
    """Valeurs-nœud d'une cellule. On ne découpe le multi-valeur que pour les
    colonnes en rôle NŒUD (co-auteurs « X & Y »…) ; un titre ou un genre est une
    valeur unique (ne pas le couper sur « & » ou « , »)."""
    if _is_blank(cell):
        return []
    if role == ROLE_NODE:
        return split_cell(cell, separators)
    return [_normalize_scalar(cell)]


def _distinct_count(df, col, role, separators, cap) -> int:
    """Nombre de valeurs distinctes d'une colonne (plafonné à cap+1)."""
    vals: set[str] = set()
    for v in df[col]:
        for x in _col_values(v, role, separators):
            vals.add(x)
        if len(vals) > cap:
            break
    return len(vals)


def _is_numeric_col(df, col) -> bool:
    """Vrai si toutes les valeurs non-vides de la colonne sont des nombres → l'agrégat
    d'un nœud sur cette dimension se fait par moyenne plutôt que par valeur dominante.
    Réutilise `_is_number` (gère la virgule décimale, convention du projet)."""
    seen = False
    for v in df[col]:
        if _is_blank(v):
            continue
        seen = True
        if not _is_number(v):
            return False
    return seen


def _to_float(v) -> float | None:
    """Parse un nombre en tolérant la virgule décimale (cohérent avec `_is_number`)."""
    try:
        return float(str(v).replace(",", ".").strip())
    except (TypeError, ValueError):
        return None


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
    layers: list[str] | None = None          # types d'entités AFFICHÉS (None = tous)
    link_mode: str = "report"                # "report" | "cut"
    show_hinge: bool = False                  # afficher les nœuds-ouvrages ?
    year_min: int | None = None
    year_max: int | None = None
    pivot: str | None = None                  # type ou id de nœud central (info pour le front)
    # Types qui RELIENT sans être affichés (ponts en mode report). None = seuls les
    # types en rôle NŒUD masqués relient (rétro-compat). Liste = seuls ces types
    # relient ; les autres types masqués sont totalement exclus (ni vus, ni reliants).
    connector_layers: list[str] | None = None
    # Focalisation (ego) : si `focus` est l'id d'un nœud, la vue est restreinte à son
    # voisinage à `hops` sauts (sous-graphe), métriques recalculées dessus (cf. /graph).
    focus: str | None = None
    hops: int = 1
    # Filtre de lisibilité : masque les nœuds à moins de `degree_min` liens dans la
    # PROJECTION (0 = aucun filtre). Appliqué après projection (cf. filter_min_degree).
    degree_min: int = 0
    # Facettes : restreint les charnières actives à celles reliées à une valeur cochée.
    # {colonne: [valeurs gardées]} ; OU au sein d'une colonne, ET entre colonnes.
    # None / vide = aucune facette (cf. project, work_active).
    facets: dict[str, list[str]] | None = None


def ego_nodes(P: nx.Graph, focus: str, hops: int) -> set[str]:
    """Nœuds à au plus `hops` sauts de `focus` dans le graphe **projeté** (BFS), focus
    inclus. Sert à la disposition « focalisation » (sous-graphe ego)."""
    if focus not in P:
        return set()
    seen = {focus}
    frontier = {focus}
    for _ in range(max(1, hops)):
        nxt: set[str] = set()
        for u in frontier:
            for v in P.neighbors(u):
                if v not in seen:
                    seen.add(v)
                    nxt.add(v)
        if not nxt:
            break
        frontier = nxt
    return seen


# Plafond de valeurs renvoyées par /facet-values. Au-delà, on tronque et on invite à
# affiner par la recherche — une colonne quasi-unique reste filtrable, sans tout lister.
FACET_VALUES_CAP = 800


def filter_columns(meta: "MasterMeta") -> list[dict[str, Any]]:
    """Colonnes filtrables : TOUTE colonne activable (nœud, attribut ou titre), avec sa
    cardinalité et son rôle. Les valeurs se chargent à la demande (/facet-values) pour
    ne pas gonfler le résumé. La colonne temps est marquée (`is_time`) — le curseur
    d'années reste l'outil naturel pour une plage, mais elle reste filtrable au besoin."""
    return [
        {"col": l["col"], "n_unique": l["n_unique"], "role": l["role"],
         "is_time": l["col"] == meta.time_col}
        for l in meta.layer_cols if l.get("activable")
    ]


def column_values(G: nx.Graph, col: str,
                  cap: int = FACET_VALUES_CAP) -> tuple[list[dict[str, Any]], bool]:
    """Valeurs distinctes d'une colonne avec leur **occurrence** (nb de charnières reliées).
    Renvoie ([{value, count}], tronqué?). Trié par fréquence décroissante puis alpha → si
    tronqué (colonne quasi-unique), on garde les valeurs les plus fréquentes. Le front
    re-trie comme l'utilisateur veut (alpha / fréquence)."""
    pairs: list[tuple[str, int]] = []
    for n, d in G.nodes(data=True):
        if d.get("kind") == "entity" and d.get("type") == col and d.get("label") is not None:
            count = sum(1 for nb in G.neighbors(n) if G.nodes[nb].get("kind") == "work")
            pairs.append((d["label"], count))
    truncated = len(pairs) > cap
    pairs.sort(key=lambda p: (-p[1], p[0]))
    return ([{"value": v, "count": c} for v, c in pairs[:cap]], truncated)


def works_passing_facets(G: nx.Graph, facets: dict[str, list[str]] | None) -> set[str] | None:
    """Charnières admises par les facettes : « coché = gardé ». Une charnière passe une
    colonne facettée si elle est reliée à ≥1 valeur **cochée** (OU dans une colonne, ET
    entre colonnes). Tout décoché dans une colonne (liste vide) = rien gardé pour cette
    colonne → résultat vide. `None`/dict vide (colonne non facettée) = aucune contrainte."""
    if not facets:
        return None
    allowed: set[str] | None = None
    for col, values in facets.items():
        col_works: set[str] = set()          # liste vide → reste vide → rien gardé
        for v in values:
            nid = f"{col}::{v}"
            if nid in G:
                col_works.update(w for w in G.neighbors(nid)
                                 if G.nodes[w].get("kind") == "work")
        allowed = col_works if allowed is None else (allowed & col_works)
    return allowed


def filter_min_degree(P: nx.Graph, k: int) -> nx.Graph:
    """Retire les nœuds dont le degré (dans la projection) est < k. **Une seule passe**,
    sans cascade (pas de k-core) → prévisible : « masquer les nœuds à moins de k liens ».
    Filtre de lisibilité (hapax/isolés) ; ne touche jamais au graphe maître."""
    if k <= 0:
        return P
    keep = [n for n, deg in P.degree() if deg >= k]
    if len(keep) == P.number_of_nodes():
        return P
    return P.subgraph(keep).copy()


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

    # Facettes : sous-ensemble de charnières reliées aux valeurs cochées (None = pas de facette).
    facet_works = works_passing_facets(G, params.facets)
    active_works = {n for n, d in G.nodes(data=True)
                    if d.get("kind") == "work" and work_active(d)
                    and (facet_works is None or n in facet_works)}

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
    node_types = set(meta.node_cols)        # types en rôle NŒUD : relient par défaut
    for n, d in G.nodes(data=True):
        if d.get("kind") == "entity" and d["type"] not in visible_types:
            t = d["type"]
            if params.connector_layers is not None:
                if t not in params.connector_layers:
                    continue                # liste explicite → seuls ces types relient
            elif t not in node_types:
                continue                    # défaut → seuls les types NŒUD masqués relient
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

    # 4b. Mode report : on contracte les « ponts ». Chaque composante connexe de
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
    """Nœuds visibles d'une composante de report : membres déjà visibles (ex. un
    ouvrage affiché, en mode show_hinge) + leurs voisins visibles dans le maître.
    Tous les membres sont de vrais nœuds du maître (ponts charnière / connecteur)."""
    boundary: set[str] = set()
    for m in component:
        if m in visible_nodes:
            boundary.add(m)
        for nb in G.neighbors(m):
            if nb in visible_nodes:
                boundary.add(nb)
    return boundary


def edge_detail(G: nx.Graph, meta: MasterMeta, u: str, v: str,
                params: ProjectionParams) -> dict[str, Any]:
    """Explique POURQUOI deux nœuds sont reliés : ouvrages communs (co-occurrence
    directe) et entités intermédiaires partagées (ex. un même traducteur). Sert à
    dé-anonymiser une arête. Respecte la fenêtre temporelle courante."""
    if u not in G or v not in G:
        raise KeyError((u, v))

    def work_active(w: str) -> bool:
        d = G.nodes[w]
        if d.get("kind") != "work":
            return False
        y = d.get("year")
        if y is None:
            return True
        if params.year_min is not None and y < params.year_min:
            return False
        if params.year_max is not None and y > params.year_max:
            return False
        return True

    def works_of(n: str) -> set[str]:
        if G.nodes[n].get("kind") == "work":
            return {n} if work_active(n) else set()
        return {w for w in G.neighbors(n) if work_active(w)}

    works_u, works_v = works_of(u), works_of(v)
    shared_works = sorted(works_u & works_v, key=lambda w: G.nodes[w].get("row", 0))

    def co_entities(works: set[str], exclude: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for w in works:
            for nb in G.neighbors(w):
                nd = G.nodes[nb]
                if nd.get("kind") == "entity" and nb != exclude:
                    out[nb] = nd
        return out

    cu, cv = co_entities(works_u, u), co_entities(works_v, v)
    shared_via: dict[str, list[str]] = {}
    for nid in (set(cu) & set(cv)):
        nd = G.nodes[nid]
        shared_via.setdefault(nd["type"], []).append(nd.get("label", nid))

    return {
        "source": u, "target": v,
        "source_label": G.nodes[u].get("label", u),
        "target_label": G.nodes[v].get("label", v),
        "shared_works": [
            {"label": G.nodes[w].get("label", w), "year": G.nodes[w].get("year")}
            for w in shared_works
        ],
        "shared_via": {t: sorted(set(vs)) for t, vs in sorted(shared_via.items())},
    }


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


def entity_card(G: nx.Graph, meta: MasterMeta, node_id: str) -> dict[str, str]:
    """Valeurs affichables sur la carte d'une **entité** (profil 2-sauts) : ses
    co-entités par type (auteurs, genres, langues, éditeurs… rencontrés via ses
    ouvrages), les attributs cumulés et sa période d'activité. Invariante par
    projection (profil complet) → comme les cartes de charnière, servie par /cards."""
    by_type: dict[str, set[str]] = {}
    attrs: dict[str, set[str]] = {}
    years: list[int] = []
    for w in G.neighbors(node_id):
        wd = G.nodes[w]
        if wd.get("kind") != "work":
            continue
        if wd.get("year") is not None:
            years.append(wd["year"])
        for k, v in (wd.get("attributes") or {}).items():
            attrs.setdefault(str(k), set()).add(str(v))
        for nb in G.neighbors(w):
            if nb == node_id:
                continue
            nd = G.nodes[nb]
            if nd.get("kind") == "entity":
                by_type.setdefault(nd["type"], set()).add(nd.get("label", nb))
    out: dict[str, str] = {t: " · ".join(sorted(v)[:6]) for t, v in by_type.items()}
    for k, v in attrs.items():
        out[k] = " · ".join(sorted(v)[:4])
    if years and meta.time_col:
        lo, hi = min(years), max(years)
        out[str(meta.time_col)] = str(lo) if lo == hi else f"{lo}–{hi}"
    return out


def all_node_cards(G: nx.Graph, meta: MasterMeta) -> dict[str, dict[str, str]]:
    """Cartes de TOUS les nœuds en une passe (servies par /cards) : charnières
    (valeurs de la ligne) ET entités (profil agrégé sur leurs ouvrages)."""
    out: dict[str, dict[str, str]] = {}
    for n, d in G.nodes(data=True):
        kind = d.get("kind")
        if kind == "work":
            out[n] = work_card(G, meta, n)
        elif kind == "entity":
            out[n] = entity_card(G, meta, n)
    return out


# --------------------------------------------------------------------------
# Agrégats par nœud — brique commune des dispositions « par attribut » (axes,
# similarité). Inerte par défaut : ni /graph ni la vue par défaut ne l'appellent.
# --------------------------------------------------------------------------

def _active_works(G: nx.Graph, params: ProjectionParams) -> set[str]:
    """Charnières dans la fenêtre temporelle courante (année absente = toujours active)."""
    out: set[str] = set()
    for n, d in G.nodes(data=True):
        if d.get("kind") != "work":
            continue
        y = d.get("year")
        if y is not None:
            if params.year_min is not None and y < params.year_min:
                continue
            if params.year_max is not None and y > params.year_max:
                continue
        out.add(n)
    return out


def _work_dim_values(G: nx.Graph, w: str, dim: str, meta: MasterMeta) -> list:
    """Valeur(s) de la dimension `dim` portées par une charnière : son année (si `dim`
    est la colonne temporelle), sinon ses entités voisines de ce type et/ou l'attribut
    de fiche du même nom — selon où la colonne vit depuis la symétrie complète."""
    d = G.nodes[w]
    if meta.time_col is not None and dim == str(meta.time_col):
        return [d["year"]] if d.get("year") is not None else []
    out: list = []
    for nb in G.neighbors(w):
        nd = G.nodes[nb]
        if nd.get("kind") == "entity" and nd.get("type") == dim:
            out.append(nd.get("label", nb))
    av = (d.get("attributes") or {}).get(dim)
    if av is not None:
        out.append(av)
    return out


def _aggregate_values(values: list, kind: str):
    """Agrège des valeurs en un scalaire : numérique → moyenne ; catégoriel → valeur
    dominante (ex æquo départagé par ordre alphabétique → résultat déterministe)."""
    if not values:
        return None
    if kind == "numeric":
        nums = [f for v in values if (f := _to_float(v)) is not None]
        return round(sum(nums) / len(nums), 4) if nums else None
    counts: dict[str, int] = {}
    for v in values:
        s = str(v)
        counts[s] = counts.get(s, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]


def axis_values(G: nx.Graph, meta: MasterMeta, params: ProjectionParams,
                dims: Iterable[str]) -> dict[str, dict[str, Any]]:
    """Pour chaque dimension demandée, l'agrégat de cette dimension par nœud, calculé
    sur ses ouvrages **actifs** (respecte la fenêtre temporelle). Généralise
    `node_mean_year` à n'importe quel attribut ; robuste à la fusion `hinge_key` (on
    parcourt les ouvrages voisins, jamais un identifiant de charnière). Renvoie
    `{dim: {node_id: valeur}}` — un nœud sans valeur pour une dimension est omis."""
    dim_list = [str(x) for x in dims if x]
    if not dim_list:
        return {}
    kind_of = {e["col"]: e.get("kind", "categorical") for e in meta.layer_cols}
    active = _active_works(G, params)
    result: dict[str, dict[str, Any]] = {dim: {} for dim in dim_list}
    for n, d in G.nodes(data=True):
        kind = d.get("kind")
        if kind == "work":
            works = [n] if n in active else []
        elif kind == "entity":
            works = [w for w in G.neighbors(n) if w in active]
        else:
            continue
        if not works:
            continue
        for dim in dim_list:
            vals: list = []
            for w in works:
                vals.extend(_work_dim_values(G, w, dim, meta))
            agg = _aggregate_values(vals, kind_of.get(dim, "categorical"))
            if agg is not None:
                result[dim][n] = agg
    return result


def similarity_edges(G: nx.Graph, meta: MasterMeta, params: ProjectionParams,
                     dims: Iterable[str], threshold: float = 0.5,
                     top_k: int = 6) -> list[dict[str, Any]]:
    """Arêtes « latentes » de SIMILARITÉ entre nœuds d'un MÊME type : on rapproche
    ceux dont les profils d'attributs se ressemblent, même sans ouvrage commun.

    Vecteur d'un nœud = comptes des valeurs de ses dimensions catégorielles choisies,
    sur ses ouvrages actifs ; similarité = cosinus. On garde les paires ≥ seuil, en
    plafonnant à `top_k` voisins par nœud (évite les cliques O(n²)). La similarité
    numérique (distance) n'est pas couverte ici — voir roadmap. Renvoie
    `[{source, target, weight}]` (weight = cosinus, paires dédupliquées)."""
    dim_list = [str(d) for d in dims if d]
    if not dim_list:
        return []
    kind_of = {e["col"]: e.get("kind", "categorical") for e in meta.layer_cols}
    cat_dims = [d for d in dim_list if kind_of.get(d, "categorical") != "numeric"]
    if not cat_dims:
        return []

    active = _active_works(G, params)
    feats: dict[str, dict[str, int]] = {}
    norms: dict[str, float] = {}
    by_type: dict[str, list[str]] = {}
    for n, d in G.nodes(data=True):
        if d.get("kind") != "entity":
            continue
        works = [w for w in G.neighbors(n) if w in active]
        if not works:
            continue
        f: dict[str, int] = {}
        for dim in cat_dims:
            for w in works:
                for v in _work_dim_values(G, w, dim, meta):
                    key = f"{dim}::{v}"
                    f[key] = f.get(key, 0) + 1
        if not f:
            continue
        feats[n] = f
        norms[n] = math.sqrt(sum(c * c for c in f.values()))
        by_type.setdefault(d["type"], []).append(n)

    # Cosinus par type ; on retient pour chaque nœud ses voisins au-dessus du seuil.
    per_node: dict[str, list[tuple[float, str]]] = {}
    for nodes in by_type.values():
        for i in range(len(nodes)):
            a = nodes[i]
            fa, na = feats[a], norms[a]
            for j in range(i + 1, len(nodes)):
                b = nodes[j]
                nb = norms[b]
                if na == 0 or nb == 0:
                    continue
                small, big = (fa, feats[b]) if len(fa) <= len(feats[b]) else (feats[b], fa)
                dot = sum(c * big[k] for k, c in small.items() if k in big)
                if dot == 0:
                    continue
                sim = dot / (na * nb)
                if sim >= threshold:
                    per_node.setdefault(a, []).append((sim, b))
                    per_node.setdefault(b, []).append((sim, a))

    edges: dict[tuple[str, str], float] = {}
    for node, lst in per_node.items():
        lst.sort(key=lambda x: (-x[0], x[1]))
        for sim, other in lst[:top_k]:
            key = (node, other) if node < other else (other, node)
            edges[key] = round(sim, 3)
    return [{"source": a, "target": b, "weight": w} for (a, b), w in edges.items()]


def _classical_mds(D: "np.ndarray", ndim: int = 2) -> "np.ndarray":
    """MDS classique (Torgerson) : double-centrage de -½D², décomposition propre,
    coordonnées = vecteurs propres dominants × √(valeurs propres positives)."""
    n = D.shape[0]
    D2 = D ** 2
    J = np.eye(n) - np.ones((n, n)) / n
    B = -0.5 * (J @ D2 @ J)
    w, V = np.linalg.eigh(B)                      # valeurs propres croissantes
    order = np.argsort(w)[::-1][:ndim]
    L = np.maximum(w[order], 0.0)
    return V[:, order] * np.sqrt(L)


def mds_positions(G: nx.Graph, meta: MasterMeta, params: ProjectionParams,
                  dims: Iterable[str]) -> dict[str, list[float]]:
    """Disposition « par similarité » (T5) : embedding 2D où la **distance à l'écran
    ≈ la dissimilarité d'attributs** (cosinus). MDS classique (décomposition propre,
    numpy — aucune dépendance nouvelle). `dims` vide → toutes les colonnes
    catégorielles activables. On n'embarque que les entités des types visibles ayant
    au moins un ouvrage actif. Déterministe (signes fixés). Renvoie `{id: [x, y]}`."""
    kind_of = {e["col"]: e.get("kind", "categorical") for e in meta.layer_cols}
    dim_list = [str(d) for d in dims if d]
    if not dim_list:
        dim_list = [e["col"] for e in meta.layer_cols
                    if e.get("activable") and e.get("kind") != "numeric"]
    cat_dims = [d for d in dim_list if kind_of.get(d, "categorical") != "numeric"]
    if not cat_dims:
        return {}

    visible_types = set(params.layers) if params.layers is not None else set(meta.node_cols)
    active = _active_works(G, params)
    nodes: list[str] = []
    feats: list[dict[str, int]] = []
    for n, d in G.nodes(data=True):
        if d.get("kind") != "entity" or d.get("type") not in visible_types:
            continue
        works = [w for w in G.neighbors(n) if w in active]
        if not works:
            continue
        f: dict[str, int] = {}
        for dim in cat_dims:
            for w in works:
                for v in _work_dim_values(G, w, dim, meta):
                    key = f"{dim}::{v}"
                    f[key] = f.get(key, 0) + 1
        if f:
            nodes.append(n)
            feats.append(f)
    if len(nodes) < 3:                            # trop peu pour un embedding utile
        return {}

    vocab = sorted({k for f in feats for k in f})
    vi = {k: i for i, k in enumerate(vocab)}
    M = np.zeros((len(nodes), len(vocab)))
    for r, f in enumerate(feats):
        for k, c in f.items():
            M[r, vi[k]] = c
    norms = np.linalg.norm(M, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    Mn = M / norms
    sim = np.clip(Mn @ Mn.T, -1.0, 1.0)
    # distance euclidienne des vecteurs L2-normalisés = √(2−2·cos) → MDS exact.
    D = np.sqrt(np.maximum(2.0 - 2.0 * sim, 0.0))
    coords = _classical_mds(D)

    mx = float(np.max(np.abs(coords))) or 1.0
    coords = coords / mx * 500.0                  # échelle d'affichage
    for k in range(coords.shape[1]):              # signes déterministes
        col = coords[:, k]
        if col[int(np.argmax(np.abs(col)))] < 0:
            coords[:, k] = -col
    return {nodes[i]: [round(float(coords[i, 0]), 2), round(float(coords[i, 1]), 2)]
            for i in range(len(nodes))}


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
    n = G.number_of_nodes()
    if n == 0:
        return {}
    # `spring_layout` est en O(n²) par itération (répulsion toutes-paires) → il ne passe
    # pas à l'échelle. Comme le front affine de toute façon avec ForceAtlas2, ces
    # positions ne sont qu'une AMORCE : on plafonne le coût.
    #  - petit/moyen graphe : itérations bornées par un budget (≈ qq secondes max) ;
    #  - gros graphe (> MAX_SPRING_NODES) : amorce aléatoire déterministe (instantanée).
    if n > MAX_SPRING_NODES:
        pos = nx.random_layout(G, seed=42)
    else:
        iters = max(15, min(120, int(SPRING_BUDGET / (n * n))))
        k = 1.0 / max(1.0, (n ** 0.5))
        pos = nx.spring_layout(G, seed=42, k=k, iterations=iters)
    return {node: [round(float(xy[0]) * scale, 4), round(float(xy[1]) * scale, 4)]
            for node, xy in pos.items()}
