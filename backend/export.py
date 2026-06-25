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
                 labels: str = "pivots", title: str | None = None,
                 time_axis: dict[str, Any] | None = None) -> tuple[bytes, str]:
    """Redessine la vue. Renvoie (octets, content_type). Si time_axis est fourni
    (réseau temporel), dessine un axe des années en bas."""
    width, height = DIMENSION_PRESETS.get(dimensions, DIMENSION_PRESETS["pleine_page"])
    fig, ax = plt.subplots(figsize=(width, height))
    fig.patch.set_facecolor(PAPER)
    ax.set_facecolor(PAPER)
    if not time_axis:
        ax.axis("off")

    pos = {n["id"]: (n["x"], n["y"]) for n in nodes}

    # Arêtes (épaisseur ∝ poids, plafonnée). Couleur/opacité par arête si fournies
    # (mode « sélection en évidence ») ; sinon gris uniforme — rendu inchangé.
    for e in edges:
        if e["source"] in pos and e["target"] in pos:
            x0, y0 = pos[e["source"]]
            x1, y1 = pos[e["target"]]
            lw = min(0.4 + 0.35 * float(e.get("weight", 1)), 3.0)
            a = float(e.get("alpha", 1.0))
            ax.plot([x0, x1], [y0, y1], color=e.get("color") or EDGE_COLOR,
                    alpha=a, linewidth=lw, zorder=(1.0 if a >= 1 else 0.5),
                    solid_capstyle="round")

    # Nœuds — opacité par nœud (mode « sélection en évidence »). On dessine le fond
    # estompé d'abord, puis les nœuds pleins au-dessus pour qu'ils ressortent.
    xs = [n["x"] for n in nodes]
    ys = [n["y"] for n in nodes]

    def _draw_nodes(group: list[dict], z: float) -> None:
        if not group:
            return
        ax.scatter(
            [n["x"] for n in group], [n["y"] for n in group],
            s=[(float(n.get("size", 6)) ** 2) * 1.6 for n in group],
            c=[_rgba(n.get("color", "#7B5BD6"), float(n.get("alpha", 1.0))) for n in group],
            edgecolors=[(1, 1, 1, float(n.get("alpha", 1.0))) for n in group],
            linewidths=0.8, zorder=z)

    faded = [n for n in nodes if float(n.get("alpha", 1.0)) < 1]
    solid = [n for n in nodes if float(n.get("alpha", 1.0)) >= 1]
    _draw_nodes(faded, 2.0)
    _draw_nodes(solid, 2.6)

    # Étiquettes selon le mode demandé (les nœuds estompés ne sont pas étiquetés).
    for n in _labelled_nodes(nodes, labels):
        ax.annotate(n.get("label", ""), (n["x"], n["y"]),
                    xytext=(0, -9), textcoords="offset points",
                    ha="center", va="top", fontsize=6.5, color=INK, zorder=3)

    if title:
        ax.set_title(title, color=INK, fontsize=12, loc="left", pad=10)

    _autoscale(ax, xs, ys)
    if time_axis:
        _draw_time_axis(ax, time_axis)
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


def render_small_multiples(panels: list[dict[str, Any]], fmt: str = "png",
                           title: str | None = None,
                           unit_singular: str = "objet",
                           unit_plural: str = "objets") -> tuple[bytes, str]:
    """Grille d'instantanés (petits multiples) : un mini-réseau par période, mêmes
    positions de nœuds et mêmes limites d'axes d'une vignette à l'autre, pour
    comparer les époques côte à côte. Exporte en PNG 300 DPI ou SVG."""
    import math
    panels = [p for p in panels if p.get("nodes")]
    if not panels:
        raise ValueError("Aucun instantané à exporter.")

    # Limites communes à toutes les vignettes (positions partagées).
    xs = [n["x"] for p in panels for n in p["nodes"]]
    ys = [n["y"] for p in panels for n in p["nodes"]]
    mx = (max(xs) - min(xs)) * 0.08 + 0.5
    my = (max(ys) - min(ys)) * 0.08 + 0.5
    xlim = (min(xs) - mx, max(xs) + mx)
    ylim = (min(ys) - my, max(ys) + my)

    n = len(panels)
    ncols = min(4, max(1, math.ceil(math.sqrt(n))))
    nrows = math.ceil(n / ncols)
    fig, axes = plt.subplots(nrows, ncols, figsize=(ncols * 3.1, nrows * 2.7))
    fig.patch.set_facecolor(PAPER)
    axes = (axes.flatten() if hasattr(axes, "flatten") else [axes])

    for ax, panel in zip(axes, panels):
        ax.set_facecolor(PAPER)
        pos = {nd["id"]: (nd["x"], nd["y"]) for nd in panel["nodes"]}
        for e in panel.get("edges", []):
            if e["source"] in pos and e["target"] in pos:
                x0, y0 = pos[e["source"]]; x1, y1 = pos[e["target"]]
                ax.plot([x0, x1], [y0, y1], color=EDGE_COLOR, linewidth=0.5, zorder=1)
        ax.scatter([n["x"] for n in panel["nodes"]], [n["y"] for n in panel["nodes"]],
                   s=[(float(n.get("size", 6)) ** 2) * 0.55 for n in panel["nodes"]],
                   c=[n.get("color", "#7B5BD6") for n in panel["nodes"]],
                   edgecolors="white", linewidths=0.5, zorder=2)
        ax.set_xlim(*xlim); ax.set_ylim(*ylim)
        ax.set_aspect("equal", adjustable="box")
        ax.set_xticks([]); ax.set_yticks([])
        for s in ax.spines.values():
            s.set_color("#E0DBD0")
        cnt = panel.get("count")
        unit = unit_plural if (cnt or 0) > 1 else unit_singular
        sub = f"  ({cnt} {unit})" if cnt is not None else ""
        ax.set_title(str(panel.get("title", "")) + sub, color=INK, fontsize=9, loc="left")

    for ax in axes[n:]:
        ax.axis("off")
    if title:
        fig.suptitle(title, color=INK, fontsize=12, x=0.02, ha="left")
    fig.tight_layout(pad=0.6)

    buf = io.BytesIO()
    fmt = fmt.lower()
    if fmt == "png":
        fig.savefig(buf, format="png", dpi=300, facecolor=PAPER, bbox_inches="tight"); ctype = "image/png"
    elif fmt == "svg":
        fig.savefig(buf, format="svg", facecolor=PAPER, bbox_inches="tight"); ctype = "image/svg+xml"
    elif fmt == "pdf":
        fig.savefig(buf, format="pdf", facecolor=PAPER, bbox_inches="tight"); ctype = "application/pdf"
    else:
        plt.close(fig); raise ValueError(f"Format non supporté : {fmt}")
    plt.close(fig)
    return buf.getvalue(), ctype


def render_chronology(chrono: dict[str, Any], fmt: str = "png",
                      title: str | None = None,
                      unit_singular: str = "objet",
                      unit_plural: str = "objets") -> tuple[bytes, str]:
    """Dot-plot chronologique : une entité par ligne, ses ouvrages dans le temps,
    un trait premier→dernier (durée d'activité), points colorés par attribut."""
    entities = chrono.get("entities", [])
    if not entities:
        raise ValueError("Aucune entité à représenter dans la chronologie.")
    ymin = chrono.get("year_min"); ymax = chrono.get("year_max")

    n = len(entities)
    fig, ax = plt.subplots(figsize=(11, max(3.0, 0.42 * n + 1.2)))
    fig.patch.set_facecolor(PAPER); ax.set_facecolor(PAPER)

    for i, e in enumerate(entities):
        y = n - 1 - i  # première ligne (plus récente) en haut
        if e["first"] != e["last"]:
            ax.plot([e["first"], e["last"]], [y, y], color="#CFC9BD", linewidth=1.4, zorder=1)
        for w in e["works"]:
            ax.scatter(w["year"], y, s=90, c=w.get("color", "#1D8A68"),
                       edgecolors="white", linewidths=1.0, zorder=2)
    ax.set_yticks(range(n))
    ax.set_yticklabels([e["label"] for e in reversed(entities)], fontsize=8)
    ax.set_xlabel("Année", color=INK, fontsize=10)
    if ymin is not None and ymax is not None:
        ax.set_xlim(ymin - 2, ymax + 2)
    ax.set_ylim(-1, n)
    ax.grid(axis="x", color="#EAE6DC", linewidth=0.8)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.tick_params(left=False)

    color_map = chrono.get("color_map") or {}
    if color_map:
        from matplotlib.lines import Line2D
        handles = [Line2D([0], [0], marker="o", linestyle="", markersize=8,
                          markerfacecolor=c, markeredgecolor="white", label=str(v))
                   for v, c in color_map.items()]
        ax.legend(handles=handles, loc="lower right", fontsize=8, frameon=False)
    ax.set_title(title or f"Chronologie des {unit_plural} — {chrono.get('pivot_type', '')}",
                 color=INK, fontsize=13, loc="left", pad=10)
    fig.tight_layout(pad=0.6)
    # Rappelle l'unité (un point = un ouvrage), comme le sous-titre de l'écran. Posé
    # après tight_layout ; `bbox_inches="tight"` agrandit l'image pour l'inclure.
    fig.text(0.01, 0.01, f"Chaque point = un {unit_singular}.",
             fontsize=8, color="#8A857B")

    buf = io.BytesIO(); fmt = fmt.lower()
    if fmt == "png":
        fig.savefig(buf, format="png", dpi=300, facecolor=PAPER, bbox_inches="tight"); ctype = "image/png"
    elif fmt == "svg":
        fig.savefig(buf, format="svg", facecolor=PAPER, bbox_inches="tight"); ctype = "image/svg+xml"
    elif fmt == "pdf":
        fig.savefig(buf, format="pdf", facecolor=PAPER, bbox_inches="tight"); ctype = "application/pdf"
    else:
        plt.close(fig); raise ValueError(f"Format non supporté : {fmt}")
    plt.close(fig)
    return buf.getvalue(), ctype


# --------------------------------------------------------------------------
# Graphiques de statistiques (barres / histogramme / matrice de co-occurrence)
# --------------------------------------------------------------------------

def _save_fig(fig, fmt: str) -> tuple[bytes, str]:
    buf = io.BytesIO(); fmt = fmt.lower()
    if fmt == "png":
        fig.savefig(buf, format="png", dpi=300, facecolor=PAPER, bbox_inches="tight"); ct = "image/png"
    elif fmt == "svg":
        fig.savefig(buf, format="svg", facecolor=PAPER, bbox_inches="tight"); ct = "image/svg+xml"
    elif fmt == "pdf":
        fig.savefig(buf, format="pdf", facecolor=PAPER, bbox_inches="tight"); ct = "application/pdf"
    else:
        plt.close(fig); raise ValueError(f"Format d'image non supporté : {fmt}")
    plt.close(fig)
    return buf.getvalue(), ct


def render_bars(rows: list[tuple[str, float]], title: str,
                fmt: str = "png", dimensions: str = "pleine_page") -> tuple[bytes, str]:
    """Barres horizontales (top-N). `rows` = [(label, valeur), …] trié décroissant."""
    if not rows:
        raise ValueError("Aucune donnée à représenter.")
    width, _ = DIMENSION_PRESETS.get(dimensions, DIMENSION_PRESETS["pleine_page"])
    labels = [str(r[0]) for r in rows][::-1]        # barh : la plus grande en haut
    values = [float(r[1]) for r in rows][::-1]
    fig, ax = plt.subplots(figsize=(width, max(2.2, 0.34 * len(rows) + 1)))
    fig.patch.set_facecolor(PAPER); ax.set_facecolor(PAPER)
    ax.barh(range(len(values)), values, color="#1D8A68", edgecolor="white", height=0.72)
    ax.set_yticks(range(len(values))); ax.set_yticklabels(labels, fontsize=8)
    ax.set_xlim(0, (max(values) * 1.08) if values else 1)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.spines["left"].set_color("#CFC9BD"); ax.spines["bottom"].set_color("#CFC9BD")
    ax.tick_params(colors="#8A857B")
    ax.set_title(title, color=INK, fontsize=13, loc="left", pad=10)
    fig.tight_layout()
    return _save_fig(fig, fmt)


def render_histogram(values: list[float], title: str, xlabel: str = "Année",
                     fmt: str = "png", dimensions: str = "pleine_page") -> tuple[bytes, str]:
    """Histogramme d'une série de nombres (ex. années moyennes des entités)."""
    vals = [float(v) for v in values if v is not None]
    if not vals:
        raise ValueError("Aucune valeur numérique à représenter (pas d'années dans cette vue ?).")
    width, height = DIMENSION_PRESETS.get(dimensions, DIMENSION_PRESETS["pleine_page"])
    fig, ax = plt.subplots(figsize=(width, height * 0.72))
    fig.patch.set_facecolor(PAPER); ax.set_facecolor(PAPER)
    span = int(max(vals)) - int(min(vals))
    bins = max(6, min(40, span + 1))
    ax.hist(vals, bins=bins, color="#3B6FA8", edgecolor="white")
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.spines["left"].set_color("#CFC9BD"); ax.spines["bottom"].set_color("#CFC9BD")
    ax.tick_params(colors="#8A857B")
    ax.set_xlabel(xlabel, color=INK, fontsize=10)
    ax.set_ylabel("Effectif", color=INK, fontsize=10)
    ax.set_title(title, color=INK, fontsize=13, loc="left", pad=10)
    fig.tight_layout()
    return _save_fig(fig, fmt)


def render_matrix(labels: list[str], mat: list[list[float]], title: str,
                  fmt: str = "png") -> tuple[bytes, str]:
    """Matrice de co-occurrence (heatmap carrée). `labels` = N noms ; `mat` = N×N poids."""
    n = len(labels)
    if n < 2:
        raise ValueError("Pas assez d'entités pour une matrice de co-occurrence.")
    side = max(4.5, 0.46 * n + 2)
    fig, ax = plt.subplots(figsize=(side, side))
    fig.patch.set_facecolor(PAPER); ax.set_facecolor(PAPER)
    im = ax.imshow(mat, cmap="YlGn", aspect="equal")
    ax.set_xticks(range(n)); ax.set_yticks(range(n))
    ax.set_xticklabels(labels, fontsize=7, rotation=45, ha="right")
    ax.set_yticklabels(labels, fontsize=7)
    mx = max((max(r) for r in mat), default=0) or 1
    for i in range(n):
        for j in range(n):
            v = mat[i][j]
            if v:
                ax.text(j, i, str(int(v)), ha="center", va="center", fontsize=6,
                        color=("white" if v >= mx * 0.6 else "#23201C"))
    ax.set_title(title, color=INK, fontsize=13, loc="left", pad=12)
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    fig.tight_layout()
    return _save_fig(fig, fmt)


def _labelled_nodes(nodes: list[dict], labels: str) -> list[dict]:
    # En mode « sélection en évidence », les nœuds estompés (alpha < 1) ne sont pas
    # étiquetés — comme à l'écran ; le nœud sélectionné l'est toujours. Sans champ
    # `alpha`/`selected` (export normal), `visible` = tous les nœuds → rendu inchangé.
    visible = [n for n in nodes if float(n.get("alpha", 1.0)) >= 1]
    forced = [n for n in nodes if n.get("selected") and n.get("label")]
    if labels == "none":
        return forced
    if labels == "all":
        return _union(forced, [n for n in visible if n.get("label")])
    # "pivots" : on étiquette les plus gros nœuds visibles (top ~20 %) + la sélection.
    labelled = [n for n in visible if n.get("label")]
    if not labelled:
        return forced
    labelled.sort(key=lambda n: float(n.get("size", 0)), reverse=True)
    cutoff = max(1, int(len(labelled) * 0.2))
    return _union(forced, labelled[:cutoff])


def _union(first: list[dict], rest: list[dict]) -> list[dict]:
    """Concatène en dédupliquant par `id`, `first` prioritaire et en tête."""
    seen = {n.get("id") for n in first}
    out = list(first)
    for n in rest:
        if n.get("id") not in seen:
            out.append(n)
            seen.add(n.get("id"))
    return out


def _rgba(hex_color: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    """Hex (#RRGGBB) + opacité → tuple RGBA flottant (pour une opacité par nœud)."""
    h = (hex_color or "").lstrip("#")
    if len(h) != 6:
        h = "7B5BD6"
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255,
            max(0.0, min(1.0, alpha)))


def _draw_time_axis(ax, ta: dict[str, Any]) -> None:
    """Dessine un axe des années en bas (réseau temporel)."""
    import math
    ymin, ymax = ta.get("year_min"), ta.get("year_max")
    w = float(ta.get("width", 1200))
    if ymin is None or ymax is None:
        return
    span = (ymax - ymin) or 1
    ax.set_yticks([])
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color("#CFC9BD")
    step = next((s for s in (1, 2, 5, 10, 20, 25, 50, 100) if span / s <= 10), 200)
    years = list(range(int(math.ceil(ymin / step)) * step, int(ymax) + 1, step))
    ax.set_xticks([((yr - ymin) / span) * w for yr in years])
    ax.set_xticklabels([str(y) for y in years], fontsize=8)
    ax.tick_params(axis="x", colors="#8A857B", length=4)
    unit_plural = ta.get("unit_plural", "objets")
    ax.set_xlabel(f"Année (moyenne des {unit_plural} liés)", color=INK, fontsize=10)


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
    # Seules les colonnes texte sont protégées contre l'injection de formule ;
    # les colonnes numériques restent des nombres (triables dans Excel).
    text_cols = {"label", "type"}
    df = pd.DataFrame(
        [{c: (_csv_safe(n.get(c, "")) if c in text_cols else n.get(c, "")) for c in cols}
         for n in nodes], columns=cols)
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, index=False, sheet_name="Métriques")
    return buf.getvalue()


def _csv_safe(value: Any) -> Any:
    """Neutralise l'injection de formule (Excel/Sheets) : une cellule TEXTE
    commençant par = + - @ (ou tab/CR) est préfixée d'une apostrophe. Les nombres
    (ex. coordonnée négative « -3.4 ») sont laissés intacts."""
    s = "" if value is None else str(value)
    if s[:1] in ("=", "+", "-", "@", "\t", "\r"):
        try:
            float(s)          # un vrai nombre → on n'y touche pas
        except ValueError:
            return "'" + s
    return s


def _csv(cols: list[str], rows: list[dict[str, Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow({c: _csv_safe(r.get(c, "")) for c in cols})
    # BOM utf-8 pour qu'Excel ouvre correctement les accents.
    return ("﻿" + buf.getvalue()).encode("utf-8")
