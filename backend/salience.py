"""
salience.py — « Ce qui ressort » : traits saillants GÉNÉRIQUES d'une projection.

Un trait saillant = un objet qui s'écarte de ses pairs. Le calcul ne connaît jamais le
NOM d'une colonne, seulement ce que le graphe projeté expose (type d'entité, degré,
intermédiarité, communauté, années via `work_years`). Un autre fichier fait donc
ressortir SES traits à lui, sans rien coder en dur.

Tout est factuel et chiffré — la rédaction appartient à l'analyste. Chaque trait porte :
  kind   : famille de signal (prolifique / passeur / paire / pont / communaute / temps / anomalie)
  grain  : node | edge | graph | time
  title  : libellé court
  detail : une phrase factuelle (gabarit déterministe, pas de plume)
  value  : la mesure d'écart (pour trier au sein d'un signal)
  refs   : ids de nœuds (pour se resituer / surligner sur la carte)
"""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from typing import Any

import networkx as nx

TOP = 5  # nb de traits gardés par signal (les plus forts ; le front en montre 3 + « voir plus »)


def compute_salience(P: nx.Graph, metrics: dict[str, Any],
                     unit_singular: str = "objet",
                     unit_plural: str = "objets") -> dict[str, Any]:
    """Calcule les traits saillants sur la projection `P` + ses `metrics` (analysis)."""
    per_node = metrics["nodes"]
    traits: list[dict] = []
    traits += _prolific(P, per_node, unit_plural)
    traits += _brokers(P, per_node)
    traits += _recurring_pairs(P, unit_plural)
    traits += _bridges(P, per_node)
    traits += _communities(P, per_node)
    traits += _temporal(P)
    traits += _anomalies(P, per_node)
    return {"traits": traits}


def _label(P: nx.Graph, n: str) -> str:
    return P.nodes[n].get("label", n)


def _entities_by_type(P: nx.Graph) -> dict[str, list[str]]:
    groups: dict[str, list[str]] = defaultdict(list)
    for n, d in P.nodes(data=True):
        if d.get("kind") == "entity":
            groups[d.get("type")].append(n)
    return groups


# --- Nœud : entités très au-dessus de la médiane de leur type (nb de charnières) -------
def _prolific(P: nx.Graph, per_node: dict, unit_p: str) -> list[dict]:
    out = []
    for typ, nodes in _entities_by_type(P).items():
        counts = [P.nodes[n].get("work_count", 0) for n in nodes]
        if len(counts) < 3:
            continue
        med = statistics.median(counts) or 1
        for n in nodes:
            wc = P.nodes[n].get("work_count", 0)
            ratio = wc / med
            if ratio >= 2 and wc >= 3:
                out.append({
                    "kind": "prolifique", "grain": "node",
                    "title": f"« {_label(P, n)} » se détache",
                    "detail": f"« {_label(P, n)} » ({typ}) apparaît dans {wc} {unit_p}, "
                              f"soit {ratio:.1f}× la médiane des {typ}.",
                    "value": round(ratio, 2), "refs": [n],
                })
    out.sort(key=lambda t: t["value"], reverse=True)
    return out[:TOP]


# --- Nœud : passeurs (forte intermédiarité = relient des groupes éloignés) -------------
def _brokers(P: nx.Graph, per_node: dict) -> list[dict]:
    ranked = sorted(P.nodes(),
                    key=lambda n: per_node[n]["betweenness"], reverse=True)
    out = []
    for n in ranked[:TOP]:
        b = per_node[n]["betweenness"]
        if b <= 0:
            break
        out.append({
            "kind": "passeur", "grain": "node",
            "title": f"Passeur : « {_label(P, n)} »",
            "detail": f"« {_label(P, n)} » relie des parties éloignées du réseau "
                      f"(intermédiarité {b:.3f}).",
            "value": round(b, 4), "refs": [n],
        })
    return out


# --- Arête : paires au poids très supérieur au poids typique ---------------------------
def _recurring_pairs(P: nx.Graph, unit_p: str) -> list[dict]:
    weights = [d.get("weight", 1) for _, _, d in P.edges(data=True)]
    if not weights:
        return []
    thr = max(2.0, 2.0 * (statistics.median(weights) or 1))
    out = []
    for u, v, d in P.edges(data=True):
        w = d.get("weight", 1)
        if w >= thr:
            out.append({
                "kind": "paire", "grain": "edge",
                "title": "Paire récurrente",
                "detail": f"« {_label(P, u)} » et « {_label(P, v)} » partagent "
                          f"{w} {unit_p}.",
                "value": w, "refs": [u, v],
            })
    out.sort(key=lambda t: t["value"], reverse=True)
    return out[:TOP]


# --- Arête : seule arête entre deux communautés (pont) ---------------------------------
def _bridges(P: nx.Graph, per_node: dict) -> list[dict]:
    pair_edges: dict[tuple, list] = defaultdict(list)
    for u, v in P.edges():
        cu, cv = per_node[u]["community"], per_node[v]["community"]
        if cu != cv:
            pair_edges[tuple(sorted((cu, cv)))].append((u, v))
    out = []
    for edges in pair_edges.values():
        if len(edges) == 1:
            u, v = edges[0]
            out.append({
                "kind": "pont", "grain": "edge",
                "title": "Pont unique",
                "detail": f"« {_label(P, u)} » et « {_label(P, v)} » forment le seul lien "
                          f"entre deux communautés.",
                "value": 1, "refs": [u, v],
            })
    return out[:TOP]


# --- Graphe : communautés (taille, membre central, composition par type) ---------------
def _communities(P: nx.Graph, per_node: dict) -> list[dict]:
    groups: dict[int, list[str]] = defaultdict(list)
    for n in P.nodes():
        groups[per_node[n]["community"]].append(n)
    out = []
    for cid, nodes in groups.items():
        if len(nodes) < 3:
            continue
        central = max(nodes, key=lambda n: (per_node[n]["betweenness"], P.degree(n)))
        comp = Counter(P.nodes[n].get("type") for n in nodes
                       if P.nodes[n].get("kind") == "entity")
        comp_txt = ", ".join(f"{c} {t}" for t, c in comp.most_common(3))
        out.append({
            "kind": "communaute", "grain": "graph",
            "title": f"Communauté de {len(nodes)} nœuds",
            "detail": f"Autour de « {_label(P, central)} »"
                      + (f" — {comp_txt}." if comp_txt else "."),
            "value": len(nodes), "refs": [central],
        })
    out.sort(key=lambda t: t["value"], reverse=True)
    return out[:TOP]


# --- Temps : entités à plus large amplitude / plus précoces / plus tardives -------------
#     UNIQUEMENT si des années sont présentes (sinon aucun signal — pas de supposition).
def _temporal(P: nx.Graph) -> list[dict]:
    spans, means = [], []
    for n, d in P.nodes(data=True):
        years = d.get("work_years") or []
        if len(years) >= 2 and max(years) > min(years):
            spans.append((n, min(years), max(years), max(years) - min(years)))
        if years:
            means.append((n, statistics.mean(years)))
    if not spans and not means:
        return []
    out = []
    for n, lo, hi, span in sorted(spans, key=lambda x: x[3], reverse=True)[:TOP]:
        out.append({
            "kind": "temps", "grain": "time",
            "title": f"Amplitude : « {_label(P, n)} »",
            "detail": f"« {_label(P, n)} » s'étend de {lo} à {hi} ({span} ans).",
            "value": span, "refs": [n],
        })
    if means:
        early = min(means, key=lambda x: x[1])
        late = max(means, key=lambda x: x[1])
        out.append({
            "kind": "temps", "grain": "time", "title": "Plus précoce",
            "detail": f"« {_label(P, early[0])} » a l'année moyenne la plus ancienne "
                      f"({early[1]:.0f}).",
            "value": -early[1], "refs": [early[0]],
        })
        out.append({
            "kind": "temps", "grain": "time", "title": "Plus tardif",
            "detail": f"« {_label(P, late[0])} » a l'année moyenne la plus récente "
                      f"({late[1]:.0f}).",
            "value": late[1], "refs": [late[0]],
        })
    return out


# --- Anomalies : nœuds isolés (0 lien) et hapax (1 lien) -------------------------------
def _anomalies(P: nx.Graph, per_node: dict) -> list[dict]:
    isolated = [n for n in P.nodes() if P.degree(n) == 0]
    hapax = [n for n in P.nodes() if P.degree(n) == 1]
    out = []
    if isolated:
        ex = ", ".join(_label(P, n) for n in isolated[:4])
        out.append({
            "kind": "anomalie", "grain": "graph", "title": f"{len(isolated)} nœud(s) isolé(s)",
            "detail": f"{len(isolated)} nœud(s) sans aucun lien dans cette vue ({ex}…).",
            "value": len(isolated), "refs": isolated[:12],
        })
    if hapax:
        out.append({
            "kind": "anomalie", "grain": "graph", "title": f"{len(hapax)} hapax (1 lien)",
            "detail": f"{len(hapax)} nœud(s) relié(s) à un seul autre — la frange du réseau.",
            "value": len(hapax), "refs": hapax[:12],
        })
    return out
