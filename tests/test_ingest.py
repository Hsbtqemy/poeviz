"""Tests du profilage et des utilitaires d'ingestion."""
import pandas as pd

from backend import ingest


def test_split_cell_separators():
    assert ingest.split_cell("Hugo & Balzac") == ["Hugo", "Balzac"]
    assert ingest.split_cell("A; B, C et D") == ["A", "B", "C", "D"]
    assert ingest.split_cell("") == []
    assert ingest.split_cell(None) == []
    # dédoublonnage en gardant l'ordre
    assert ingest.split_cell("X & X & Y") == ["X", "Y"]


def test_pluralize_fr():
    assert ingest.pluralize_fr("objet") == "objets"
    assert ingest.pluralize_fr("tableau") == "tableaux"   # -eau → -eaux
    assert ingest.pluralize_fr("jeu") == "jeux"           # -eu → -eux
    assert ingest.pluralize_fr("prix") == "prix"          # -x inchangé
    assert ingest.pluralize_fr("film") == "films"
    assert ingest.pluralize_fr("") == ""


def test_singularize_fr():
    assert ingest.singularize_fr("traductions") == "traduction"
    assert ingest.singularize_fr("film") == "film"
    # noms invariants au pluriel : ne pas couper le « s » (sinon « avi », « repa »…)
    for invariant in ("avis", "repas", "pays", "prix", "bus", "corps"):
        assert ingest.singularize_fr(invariant) == invariant
    # une feuille « Avis » suggère une unité invariante, pas « avi »
    assert ingest.default_unit_label("Avis") == ("avis", "avis")


def test_default_unit_label():
    assert ingest.default_unit_label("Traductions") == ("traduction", "traductions")
    assert ingest.default_unit_label("Feuil1") == ("objet", "objets")
    assert ingest.default_unit_label("Sheet1") == ("objet", "objets")
    assert ingest.default_unit_label("") == ("objet", "objets")
    assert ingest.default_unit_label("Films") == ("film", "films")


def test_suggest_role():
    # Texte quasi-unique → lien ; texte répété → nœud ; nombre → info.
    assert ingest.suggest_role("text", 100, 0.99, False) == ingest.ROLE_EDGE
    assert ingest.suggest_role("text", 10, 0.4, False) == ingest.ROLE_NODE
    assert ingest.suggest_role("number", 50, 0.9, True) == ingest.ROLE_ATTRIBUTE


def test_profile_dataframe():
    df = pd.DataFrame({
        "Titre": [f"Livre {i}" for i in range(6)],          # quasi-unique → edge
        "Auteur": ["A", "B", "A", "C", "B", "A"],            # répété → node
        "Année": [2000, 2001, 2002, 2000, 2001, 2003],       # nombre → attribute
    })
    profs = {p.name: p for p in ingest.profile_dataframe(df)}
    assert profs["Titre"].suggested_role == ingest.ROLE_EDGE
    assert profs["Auteur"].suggested_role == ingest.ROLE_NODE
    assert profs["Année"].suggested_role == ingest.ROLE_ATTRIBUTE
    assert profs["Auteur"].n_unique == 3
