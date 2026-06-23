"""Tests du graphe maître et des projections (le cœur de l'outil)."""
import pandas as pd
import pytest

from backend import ingest, graph

SEP = ingest.DEFAULT_SEPARATORS


def make_df():
    # 3 lignes ; A et B partagent l'éditeur E1 ; A apparaît 2 fois.
    return pd.DataFrame({
        "Titre": ["T1", "T2", "T3"],
        "Auteur": ["A", "A", "B"],
        "Éditeur": ["E1", "E2", "E1"],
        "Année": [2000, 2010, 2020],
    })


ROLES = {"Titre": "edge", "Auteur": "node", "Éditeur": "node", "Année": "attribute"}


def test_master_is_bipartite():
    G, meta = graph.build_master_graph(make_df(), ROLES, SEP)
    works = [n for n, d in G.nodes(data=True) if d.get("kind") == "work"]
    ents = [n for n, d in G.nodes(data=True) if d.get("kind") == "entity"]
    assert len(works) == 3                      # une charnière par ligne
    assert meta.n_works == 3
    # entités : A, B (auteurs) + E1, E2 (éditeurs) = 4
    assert len(ents) == 4
    # graphe biparti : aucune arête entité──entité
    for u, v in G.edges():
        kinds = {G.nodes[u]["kind"], G.nodes[v]["kind"]}
        assert kinds == {"entity", "work"}


def test_projection_report_links_shared():
    """En report (charnière masquée), deux éditeurs reliés au même auteur via
    leurs ouvrages se retrouvent connectés."""
    G, meta = graph.build_master_graph(make_df(), ROLES, SEP)
    P = graph.project(G, meta, graph.ProjectionParams(link_mode="report", show_hinge=False))
    # A (lignes T1,T2) relie E1 et E2 ; B (T3) relie E1. Tout est dans une composante.
    assert P.number_of_edges() > 0
    # auteur A et éditeur E1 partagent la ligne T1 → reliés
    assert P.has_edge("Auteur::A", "Éditeur::E1")


def test_projection_cut_disconnects():
    G, meta = graph.build_master_graph(make_df(), ROLES, SEP)
    P = graph.project(G, meta, graph.ProjectionParams(link_mode="cut", show_hinge=False))
    # cut + charnière masquée : plus aucun lien (graphe biparti → rien en direct)
    assert P.number_of_edges() == 0


def test_projection_show_hinge():
    G, meta = graph.build_master_graph(make_df(), ROLES, SEP)
    P = graph.project(G, meta, graph.ProjectionParams(show_hinge=True))
    works = [n for n, d in P.nodes(data=True) if d.get("kind") == "work"]
    assert len(works) == 3
    # entité reliée à sa charnière
    assert P.has_edge("Auteur::A", "work::0")


def test_year_window_filters_works():
    G, meta = graph.build_master_graph(make_df(), ROLES, SEP)
    P = graph.project(G, meta, graph.ProjectionParams(
        show_hinge=True, year_min=2005, year_max=2025))
    works = [n for n, d in P.nodes(data=True) if d.get("kind") == "work"]
    assert len(works) == 2          # T1 (2000) exclu


def test_hinge_key_merges_rows():
    """Deux lignes partageant la clé fusionnent en une seule charnière."""
    df = pd.DataFrame({
        "Oeuvre": ["o1", "o1", "o2"],
        "Titre": ["VO", "VF", "Autre"],
        "Auteur": ["A", "A", "B"],
        "Langue": ["ro", "fr", "ro"],
        "Année": [1990, 2000, 1995],
    })
    roles = {"Oeuvre": "node", "Titre": "edge", "Auteur": "node",
             "Langue": "node", "Année": "attribute"}
    G, meta = graph.build_master_graph(df, roles, SEP, hinge_key="Oeuvre")
    works = [n for n, d in G.nodes(data=True) if d.get("kind") == "work"]
    assert len(works) == 2 and meta.n_works == 2          # o1 fusionné
    assert meta.hinge_key == "Oeuvre"
    # la clé n'est PAS une entité affichée
    assert "Oeuvre" not in meta.node_cols
    assert not any(d.get("type") == "Oeuvre" for _, d in G.nodes(data=True))
    w = G.nodes["work::key::o1"]
    assert "VO" in w["label"] and "VF" in w["label"]      # titres cumulés
    assert w["year"] == 1990                              # année = la plus ancienne
    # les deux langues de l'œuvre sont rattachées à la même charnière
    langs = {G.nodes[nb]["label"] for nb in G.neighbors("work::key::o1")
             if G.nodes[nb].get("type") == "Langue"}
    assert langs == {"ro", "fr"}


def test_hinge_key_mean_year_survives_merge():
    """Régression : sous `hinge_key`, l'année moyenne d'une entité doit se lire
    sur la charnière fusionnée (id `work::key::…`) et non via un `work::{row}`
    reconstruit — sinon couleur par époque et axe temporel retombent sur None."""
    df = pd.DataFrame({
        "Oeuvre": ["o1", "o1", "o2"],
        "Titre":  ["VO", "VF", "Autre"],
        "Auteur": ["A", "A", "B"],
        "Langue": ["ro", "fr", "ro"],
        "Année":  [1990, 2000, 1995],
    })
    roles = {"Oeuvre": "node", "Titre": "edge", "Auteur": "node",
             "Langue": "node", "Année": "attribute"}
    G, meta = graph.build_master_graph(df, roles, SEP, hinge_key="Oeuvre")
    P = graph.project(G, meta, graph.ProjectionParams(show_hinge=False))
    # A n'est relié qu'à la charnière fusionnée o1 (année = la plus ancienne, 1990).
    a = P.nodes["Auteur::A"]
    assert a["work_years"] == [1990]
    assert graph.node_mean_year(a) == 1990.0      # ni None ni KeyError
    assert graph.node_mean_year(P.nodes["Auteur::B"]) == 1995.0


def test_edge_set_not_leaked():
    """Le tampon interne `_edge_set` (fusion) ne doit subsister ni sur le graphe
    maître ni sur les projections."""
    G, meta = graph.build_master_graph(make_df(), ROLES, SEP)
    assert not any("_edge_set" in d for _, d in G.nodes(data=True))
    P = graph.project(G, meta, graph.ProjectionParams(show_hinge=True))
    assert not any("_edge_set" in d for _, d in P.nodes(data=True))


def test_empty_roles_no_entities():
    G, meta = graph.build_master_graph(make_df(), {"Titre": "edge"}, SEP)
    assert sum(meta.type_counts.values()) == 0           # aucune entité


def make_lens_df():
    # A & B partagent le traducteur Tx ; A & C partagent l'éditeur E1.
    return pd.DataFrame({
        "Titre": ["T1", "T2", "T3"],
        "Auteur": ["A", "B", "C"],
        "Traducteur": ["Tx", "Tx", "Ty"],
        "Éditeur": ["E1", "E2", "E1"],
    })


LENS_ROLES = {"Titre": "edge", "Auteur": "node", "Traducteur": "node", "Éditeur": "node"}


def test_edge_detail_explains_link():
    G, meta = graph.build_master_graph(make_lens_df(), LENS_ROLES, SEP)
    d = graph.edge_detail(G, meta, "Auteur::A", "Auteur::B", graph.ProjectionParams())
    assert d["shared_via"].get("Traducteur") == ["Tx"]   # reliés via le traducteur
    assert not d["shared_works"]                          # pas d'ouvrage commun
    d2 = graph.edge_detail(G, meta, "Auteur::A", "Auteur::C", graph.ProjectionParams())
    assert d2["shared_via"].get("Éditeur") == ["E1"]


def test_connector_layers_isolate_lens():
    """La lentille : seuls les types connecteurs relient ; les autres sont exclus."""
    G, meta = graph.build_master_graph(make_lens_df(), LENS_ROLES, SEP)
    via_trad = graph.project(G, meta, graph.ProjectionParams(
        layers=["Auteur"], connector_layers=["Traducteur"]))
    assert via_trad.has_edge("Auteur::A", "Auteur::B")       # via traducteur Tx
    assert not via_trad.has_edge("Auteur::A", "Auteur::C")   # éditeur exclu
    via_edit = graph.project(G, meta, graph.ProjectionParams(
        layers=["Auteur"], connector_layers=["Éditeur"]))
    assert via_edit.has_edge("Auteur::A", "Auteur::C")       # via éditeur E1
    assert not via_edit.has_edge("Auteur::A", "Auteur::B")


def test_connector_attr_lens():
    """Une colonne-attribut (ex. Genre) peut servir de lentille sans devenir nœud."""
    df = pd.DataFrame({
        "Titre": ["T1", "T2", "T3"],
        "Auteur": ["A", "B", "C"],
        "Genre": ["Roman", "Roman", "Essai"],     # A & B partagent le genre
    })
    roles = {"Titre": "edge", "Auteur": "node", "Genre": "attribute"}
    G, meta = graph.build_master_graph(df, roles, SEP)
    assert "Genre" in meta.lens_attrs                       # proposée comme lentille
    assert not any(d.get("type") == "Genre" for _, d in G.nodes(data=True))  # pas un nœud
    # sans lentille : auteurs seuls, rien ne les relie
    p0 = graph.project(G, meta, graph.ProjectionParams(layers=["Auteur"], connector_layers=[]))
    assert not p0.has_edge("Auteur::A", "Auteur::B")
    # avec Genre en lentille : A & B (Roman) reliés ; C (Essai) à part
    p = graph.project(G, meta, graph.ProjectionParams(
        layers=["Auteur"], connector_layers=[], connector_attrs=["Genre"]))
    assert p.has_edge("Auteur::A", "Auteur::B")
    assert not p.has_edge("Auteur::A", "Auteur::C")


def test_lens_attrs_excludes_time_column():
    G, meta = graph.build_master_graph(make_df(), ROLES, SEP)   # Année = colonne temps
    assert "Année" not in meta.lens_attrs
