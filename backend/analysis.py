"""
analysis.py — Analyse réseau sur le graphe *projeté* courant.

On calcule, à la demande, sur la projection (jamais sur le maître) :
  - degré, intermédiarité (betweenness), centralité de vecteur propre,
  - communautés (Louvain ; repli greedy_modularity si python-louvain absent),
  - composantes connexes, densité, nombres de nœuds/arêtes,
  - top N nœuds par centralité (les « pivots »).
"""
from __future__ import annotations

from typing import Any

import networkx as nx

# Louvain (python-louvain) avec repli sur networkx si indisponible.
try:
    import community as community_louvain  # python-louvain
    _HAS_LOUVAIN = True
except Exception:  # pragma: no cover
    _HAS_LOUVAIN = False

# Palette catégorielle pour colorer par communauté (couleurs distinctes, sobres).
COMMUNITY_PALETTE = [
    "#1D8A68", "#7B5BD6", "#C07A1A", "#3B6FA8", "#B8453F",
    "#4F9D8A", "#A0568C", "#6B8E23", "#C2553B", "#5470B0",
    "#9C6B2E", "#8A857B",
]

CENTRALITY_KEYS = ("degree", "betweenness", "eigenvector")


def compute_metrics(P: nx.Graph, size_by: str = "degree") -> dict[str, Any]:
    """Renvoie les métriques par nœud + un résumé du graphe projeté."""
    n = P.number_of_nodes()
    m = P.number_of_edges()

    degree = _normalized_degree(P)
    betweenness = _safe_betweenness(P)
    eigenvector = _safe_eigenvector(P)
    communities = detect_communities(P)

    per_node: dict[str, dict[str, Any]] = {}
    for node in P.nodes():
        per_node[node] = {
            "degree": round(degree.get(node, 0.0), 5),
            "degree_raw": P.degree(node),
            "betweenness": round(betweenness.get(node, 0.0), 5),
            "eigenvector": round(eigenvector.get(node, 0.0), 5),
            "community": communities.get(node, 0),
        }

    size_key = size_by if size_by in CENTRALITY_KEYS else "degree"
    top_central = sorted(
        per_node.items(), key=lambda kv: kv[1][size_key], reverse=True
    )[:10]

    summary = {
        "n_nodes": n,
        "n_edges": m,
        "density": round(nx.density(P), 5) if n > 1 else 0.0,
        "n_components": nx.number_connected_components(P) if n else 0,
        "n_communities": len(set(communities.values())) if communities else 0,
        "avg_degree": round(2 * m / n, 3) if n else 0.0,
        "top_central": [
            {"id": nid, "label": P.nodes[nid].get("label", nid),
             "type": P.nodes[nid].get("type"), "value": vals[size_key]}
            for nid, vals in top_central
        ],
        "size_by": size_key,
    }
    return {"nodes": per_node, "summary": summary}


def _normalized_degree(P: nx.Graph) -> dict[str, float]:
    n = P.number_of_nodes()
    if n <= 1:
        return {node: 0.0 for node in P.nodes()}
    return {node: deg / (n - 1) for node, deg in P.degree()}


def _safe_betweenness(P: nx.Graph) -> dict[str, float]:
    if P.number_of_nodes() < 3:
        return {node: 0.0 for node in P.nodes()}
    try:
        return nx.betweenness_centrality(P, weight="weight", normalized=True)
    except Exception:
        return {node: 0.0 for node in P.nodes()}


def _safe_eigenvector(P: nx.Graph) -> dict[str, float]:
    """La centralité de vecteur propre peut ne pas converger (graphe déconnecté).
    On la calcule par composante, avec repli sur le degré normalisé."""
    if P.number_of_nodes() == 0:
        return {}
    result: dict[str, float] = {}
    for component in nx.connected_components(P):
        sub = P.subgraph(component)
        try:
            if sub.number_of_nodes() < 3 or sub.number_of_edges() == 0:
                raise nx.NetworkXError("composante trop petite")
            ev = nx.eigenvector_centrality(sub, max_iter=1000, weight="weight")
        except Exception:
            # Repli : degré normalisé local.
            deg = dict(sub.degree())
            mx = max(deg.values()) if deg else 1
            ev = {k: (v / mx if mx else 0.0) for k, v in deg.items()}
        result.update(ev)
    return result


def detect_communities(P: nx.Graph) -> dict[str, int]:
    """Partition en communautés. Louvain si dispo, sinon greedy_modularity."""
    if P.number_of_nodes() == 0:
        return {}
    if P.number_of_edges() == 0:
        # Chaque nœud isolé = sa propre communauté.
        return {node: i for i, node in enumerate(P.nodes())}
    if _HAS_LOUVAIN:
        try:
            return community_louvain.best_partition(P, weight="weight", random_state=42)
        except Exception:
            pass
    # Repli networkx.
    try:
        communities = nx.community.greedy_modularity_communities(P, weight="weight")
        mapping: dict[str, int] = {}
        for i, group in enumerate(communities):
            for node in group:
                mapping[node] = i
        return mapping
    except Exception:
        return {node: 0 for node in P.nodes()}


def community_color(community_id: int) -> str:
    return COMMUNITY_PALETTE[community_id % len(COMMUNITY_PALETTE)]
