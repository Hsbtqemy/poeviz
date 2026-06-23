"""Tests des sorties fichier (anti-injection, échappement)."""
from backend import export


def test_csv_safe_neutralizes_formulas():
    assert export._csv_safe("=cmd()") == "'=cmd()"
    assert export._csv_safe("+SUM(A1)") == "'+SUM(A1)"
    assert export._csv_safe("@x") == "'@x"
    assert export._csv_safe("normal") == "normal"
    # un vrai nombre négatif n'est PAS préfixé (reste numérique)
    assert export._csv_safe("-3.4") == "-3.4"
    assert export._csv_safe(-3.4) == "-3.4"


def test_nodes_csv_escapes_formula_label():
    data = [{"id": "x", "label": "=HYPERLINK(1)", "type": "Auteur"}]
    out = export.nodes_csv(data).decode("utf-8")
    assert "'=HYPERLINK(1)" in out


def test_gexf_xml_escaped():
    nodes = [{"id": "n1", "label": "A & <B>", "type": "Auteur", "color": "#1D8A68"}]
    edges = []
    xml = export.build_gexf(nodes, edges).decode("utf-8")
    assert "A &amp; &lt;B&gt;" in xml
    assert "<gexf" in xml
