"""
export.py — Sorties fichier.

Image : matplotlib redessine la *vue courante* à partir des positions reçues
du front (mêmes positions, couleurs, tailles, filtres) → l'image correspond à
l'écran. Destination première : Word → PNG net (300 DPI) + SVG vectoriel.

Données : GEXF (réouverture dans Gephi), CSV nœuds, CSV arêtes, table des
métriques (CSV ou XLSX).

Toutes les fonctions opèrent sur la structure « vue » canonique (les mêmes
dictionnaires nœud/arête que renvoie /graph), pour rester cohérent.
"""
from __future__ import annotations

import csv
import io
from typing import Any
from xml.sax.saxutils import escape

import matplotlib
matplotlib.use("Agg")  # backend sans affichage
import matplotlib.pyplot as plt

PAPER = "#F7F4EE"
EDGE_COLOR = "#CFC9BD"
INK = "#23201C"

# Préréglages de dimensions (pouces) pour l'intégration Word.
DIMENSION_PRESETS = {
    "pleine_page": (10.0, 7.2),
    "colonne": (5.2, 4.2),
    "carre": (7.5, 7.5),
}


# --------------------------------------------------------------------------
# Image (PNG / SVG / PDF)
# --------------------------------------------------------------------------

def render_image(nodes: list[dict[str, Any]], edges: list[dict[str, Any]],
                 fmt: str = "png", dimensions: str = "pleine_page",
                 labels: str = "pivots", title: str | None = None) -> tuple[bytes, str]:
    """Redessine la vue. Renvoie (octets, content_type)."""
    width, height = DIMENSION_PRESETS.get(dimensions, DIMENSION_PRESETS["pleine_page"])
    fig, ax = plt.subplots(figsize=(width, height))
    fig.patch.set_facecolor(PAPER)
    ax.set_facecolor(PAPER)
    ax.axis("off")

    pos = {n["id"]: (n["x"], n["y"]) for n in nodes}

    # Arêtes (épaisseur ∝ poids, plafonnée).
    for e in edges:
        if e["source"] in pos and e["target"] in pos:
            x0, y0 = pos[e["source"]]
            x1, y1 = pos[e["target"]]
            lw = min(0.4 + 0.35 * float(e.get("weight", 1)), 3.0)
            ax.plot([x0, x1], [y0, y1], color=EDGE_COLOR, linewidth=lw,
                    zorder=1, solid_capstyle="round")

    # Nœuds.
    xs = [n["x"] for n in nodes]
    ys = [n["y"] for n in nodes]
    colors = [n.get("color", "#7B5BD6") for n in nodes]
    sizes = [(float(n.get("size", 6)) ** 2) * 1.6 for n in nodes]
    ax.scatter(xs, ys, s=sizes, c=colors, edgecolors="white",
               linewidths=0.8, zorder=2)

    # Étiquettes selon le mode demandé.
    for n in _labelled_nodes(nodes, labels):
        ax.annotate(n.get("label", ""), (n["x"], n["y"]),
                    xytext=(0, -9), textcoords="offset points",
                    ha="center", va="top", fontsize=6.5, color=INK, zorder=3)

    if title:
        ax.set_title(title, color=INK, fontsize=12, loc="left", pad=10)

    _autoscale(ax, xs, ys)
    fig.tight_layout(pad=0.4)

    buf = io.BytesIO()
    fmt = fmt.lower()
    if fmt == "png":
        fig.savefig(buf, format="png", dpi=300, facecolor=PAPER, bbox_inches="tight")
        ctype = "image/png"
    elif fmt == "svg":
        fig.savefig(buf, format="svg", facecolor=PAPER, bbox_inches="tight")
        ctype = "image/svg+xml"
    elif fmt == "pdf":
        fig.savefig(buf, format="pdf", facecolor=PAPER, bbox_inches="tight")
        ctype = "application/pdf"
    else:
        plt.close(fig)
        raise ValueError(f"Format d'image non supporté : {fmt}")
    plt.close(fig)
    return buf.getvalue(), ctype


def _labelled_nodes(nodes: list[dict], labels: str) -> list[dict]:
    if labels == "none":
        return []
    if labels == "all":
        return [n for n in nodes if n.get("label")]
    # "pivots" : on étiquette les plus gros nœuds (top ~20 %).
    labelled = [n for n in nodes if n.get("label")]
    if not labelled:
        return []
    labelled.sort(key=lambda n: float(n.get("size", 0)), reverse=True)
    cutoff = max(1, int(len(labelled) * 0.2))
    return labelled[:cutoff]


def _autoscale(ax, xs, ys) -> None:
    if not xs:
        return
    margin_x = (max(xs) - min(xs)) * 0.08 + 0.5
    margin_y = (max(ys) - min(ys)) * 0.08 + 0.5
    ax.set_xlim(min(xs) - margin_x, max(xs) + margin_x)
    ax.set_ylim(min(ys) - margin_y, max(ys) + margin_y)
    ax.set_aspect("equal", adjustable="datalim")


# --------------------------------------------------------------------------
# GEXF (Gephi)
# --------------------------------------------------------------------------

def build_gexf(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> bytes:
    """Écrit un GEXF avec positions, couleurs et attributs (réouvrable dans Gephi)."""
    attr_defs = [
        ("type", "string"), ("kind", "string"),
        ("community", "integer"), ("degree", "float"),
        ("betweenness", "float"), ("eigenvector", "float"),
    ]
    out = io.StringIO()
    out.write('<?xml version="1.0" encoding="UTF-8"?>\n')
    out.write('<gexf xmlns="http://gexf.net/1.3" version="1.3" '
              'xmlns:viz="http://gexf.net/1.3/viz">\n')
    out.write('<graph mode="static" defaultedgetype="undirected">\n')
    out.write('<attributes class="node">\n')
    for i, (name, typ) in enumerate(attr_defs):
        out.write(f'<attribute id="{i}" title="{name}" type="{typ}"/>\n')
    out.write('</attributes>\n<nodes>\n')
    for n in nodes:
        nid = escape(str(n["id"]))
        label = escape(str(n.get("label", n["id"])))
        out.write(f'<node id="{nid}" label="{label}">\n')
        out.write('<attvalues>\n')
        for i, (name, _) in enumerate(attr_defs):
            val = n.get(name, "")
            out.write(f'<attvalue for="{i}" value="{escape(str(val))}"/>\n')
        out.write('</attvalues>\n')
        r, g, b = _hex_to_rgb(n.get("color", "#7B5BD6"))
        out.write(f'<viz:color r="{r}" g="{g}" b="{b}"/>\n')
        out.write(f'<viz:position x="{float(n.get("x", 0))}" '
                  f'y="{float(n.get("y", 0))}" z="0.0"/>\n')
        out.write(f'<viz:size value="{float(n.get("size", 6))}"/>\n')
        out.write('</node>\n')
    out.write('</nodes>\n<edges>\n')
    for i, e in enumerate(edges):
        s = escape(str(e["source"]))
        t = escape(str(e["target"]))
        w = float(e.get("weight", 1))
        out.write(f'<edge id="{i}" source="{s}" target="{t}" weight="{w}"/>\n')
    out.write('</edges>\n</graph>\n</gexf>\n')
    return out.getvalue().encode("utf-8")


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return (123, 91, 214)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


# --------------------------------------------------------------------------
# CSV / métriques
# --------------------------------------------------------------------------

def nodes_csv(nodes: list[dict[str, Any]]) -> bytes:
    cols = ["id", "label", "type", "kind", "community",
            "degree", "degree_raw", "betweenness", "eigenvector",
            "work_count", "color", "x", "y"]
    return _csv(cols, nodes)


def edges_csv(edges: list[dict[str, Any]]) -> bytes:
    cols = ["source", "target", "weight"]
    return _csv(cols, edges)


def metrics_csv(nodes: list[dict[str, Any]]) -> bytes:
    cols = ["label", "type", "community", "degree", "betweenness",
            "eigenvector", "degree_raw", "work_count"]
    return _csv(cols, nodes)


def metrics_xlsx(nodes: list[dict[str, Any]]) -> bytes:
    import pandas as pd
    cols = ["label", "type", "community", "degree", "betweenness",
            "eigenvector", "degree_raw", "work_count"]
    df = pd.DataFrame([{c: n.get(c, "") for c in cols} for n in nodes], columns=cols)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Métriques")
    return buf.getvalue()


def _csv(cols: list[str], rows: list[dict[str, Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow({c: r.get(c, "") for c in cols})
    # BOM utf-8 pour qu'Excel ouvre correctement les accents.
    return ("﻿" + buf.getvalue()).encode("utf-8")
