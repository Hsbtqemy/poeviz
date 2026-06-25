"""Tests de la salience (« ce qui ressort ») — générique, déterministe."""
import pandas as pd

from backend import ingest, graph, analysis, salience

SEP = ingest.DEFAULT_SEPARATORS


def _prep(df, roles, **kw):
    G, meta = graph.build_master_graph(df, roles, SEP, **kw)
    P = graph.project(G, meta, graph.ProjectionParams())
    metrics = analysis.compute_metrics(P)
    return P, metrics, meta


def test_prolific_designates_top_of_type():
    """L'auteur présent dans le plus d'ouvrages, très au-dessus de la médiane de son
    type, ressort comme « se détache ». Déterministe."""
    df = pd.DataFrame({
        "Titre": ["T1", "T2", "T3", "T4", "T5"],
        "Auteur": ["A", "A", "A", "B", "C"],          # A dans 3 ouvrages, B et C dans 1
        "Éditeur": ["E1", "E2", "E3", "E1", "E2"],
    })
    roles = {"Titre": "edge", "Auteur": "node", "Éditeur": "node"}
    P, metrics, meta = _prep(df, roles)
    res = salience.compute_salience(P, metrics, "livre", "livres")
    prolific = [t for t in res["traits"] if t["kind"] == "prolifique"]
    labels = {P.nodes[t["refs"][0]].get("label") for t in prolific}
    assert "A" in labels                                # A (work_count 3) se détache
    assert all(t["value"] >= 2 for t in prolific)       # ratio ≥ 2× la médiane
    # déterminisme : deux calculs donnent la même structure
    res2 = salience.compute_salience(P, metrics, "livre", "livres")
    assert res == res2


def test_no_temporal_signal_without_dates():
    """Sans colonne date, AUCUN signal temporel n'est produit (pas de supposition, pas de
    crash) — critère d'acceptation T2."""
    df = pd.DataFrame({
        "Titre": ["T1", "T2", "T3"],
        "Auteur": ["A", "B", "C"],
        "Genre": ["Roman", "Roman", "Essai"],
    })
    roles = {"Titre": "edge", "Auteur": "node", "Genre": "attribute"}
    P, metrics, meta = _prep(df, roles)
    res = salience.compute_salience(P, metrics)
    assert [t for t in res["traits"] if t["grain"] == "time"] == []


def test_temporal_amplitude_when_dates_present():
    """Avec des années, l'entité à la plus large amplitude ressort."""
    df = pd.DataFrame({
        "Titre": ["T1", "T2", "T3"],
        "Auteur": ["A", "A", "B"],            # A : 1950 et 2000 (amplitude 50) ; B : 1990
        "Année": [1950, 2000, 1990],
    })
    roles = {"Titre": "edge", "Auteur": "node", "Année": "attribute"}
    P, metrics, meta = _prep(df, roles)
    res = salience.compute_salience(P, metrics)
    spans = [t for t in res["traits"] if t["kind"] == "temps" and t["title"].startswith("Amplitude")]
    assert spans and P.nodes[spans[0]["refs"][0]].get("label") == "A"
    assert spans[0]["value"] == 50


def test_every_trait_is_renderable():
    """Chaque trait porte de quoi se rendre ET se phraser : objet identifiable + valeur."""
    df = pd.DataFrame({
        "Titre": ["T1", "T2", "T3", "T4"],
        "Auteur": ["A", "A", "A", "B"],
        "Éditeur": ["E1", "E2", "E1", "E2"],
        "Année": [1990, 1995, 2010, 2000],
    })
    roles = {"Titre": "edge", "Auteur": "node", "Éditeur": "node", "Année": "attribute"}
    P, metrics, meta = _prep(df, roles)
    res = salience.compute_salience(P, metrics, "traduction", "traductions")
    for t in res["traits"]:
        assert t["kind"] and t["grain"] in {"node", "edge", "graph", "time"}
        assert t["title"] and t["detail"]
        assert "value" in t and isinstance(t["refs"], list) and t["refs"]
