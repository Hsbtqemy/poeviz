"""Tests d'intégration de l'API via le TestClient FastAPI."""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.main as M
from backend.main import app

client = TestClient(app)
DATA = Path(__file__).resolve().parent.parent / "data"

DEMO_ROLES = {
    "Titre": "edge", "Auteur": "node", "Traducteur": "node", "Maison d'édition": "node",
    "Année": "attribute", "Genre": "attribute", "Langue source": "attribute",
    "Langue cible": "attribute", "Lieu": "attribute", "Réédition": "attribute",
    "Langue d'origine de l'auteur": "attribute",
}


def configured_demo():
    sid = client.get("/demo").json()["session_id"]
    client.get(f"/profile?session_id={sid}")
    client.post("/configure", json={"session_id": sid, "roles": DEMO_ROLES,
                                     "unit_singular": "traduction"})
    return sid


def test_health():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_profile_suggests_unit():
    sid = client.get("/demo").json()["session_id"]
    p = client.get(f"/profile?session_id={sid}").json()
    assert p["suggested_unit"]["singular"] == "traduction"
    assert any(c["name"] == "Auteur" for c in p["columns"])


def test_configure_and_graph():
    sid = client.get("/demo").json()["session_id"]
    client.get(f"/profile?session_id={sid}")
    cfg = client.post("/configure", json={"session_id": sid, "roles": DEMO_ROLES,
                                          "unit_singular": "traduction"}).json()
    # unit_plural est dérivé et renvoyé dans le résumé de /configure (meta).
    assert cfg["summary"]["unit_plural"] == "traductions"
    assert cfg["summary"]["n_works"] == 25
    g = client.get(f"/graph?session_id={sid}").json()
    assert len(g["nodes"]) > 0 and len(g["edges"]) > 0


def test_cards_endpoint_and_graph_omits_card():
    sid = configured_demo()
    # Les cartes ne voyagent plus dans /graph (invariantes par projection) ...
    g = client.get(f"/graph?session_id={sid}&show_hinge=true").json()
    assert all("card" not in n for n in g["nodes"])
    works = [n["id"] for n in g["nodes"] if n["kind"] == "work"]
    # ... mais dans /cards : un dict {id charnière: {type: valeurs jointes}}.
    cards = client.get(f"/cards?session_id={sid}").json()
    assert works and works[0] in cards
    assert "Auteur" in cards[works[0]]
    # une entité n'a pas de carte
    ent = next(n["id"] for n in g["nodes"] if n["kind"] == "entity")
    assert ent not in cards


def test_node_detail_and_metrics():
    sid = configured_demo()
    g = client.get(f"/graph?session_id={sid}").json()
    nid = next(n["id"] for n in g["nodes"] if n["kind"] == "entity")
    nd = client.get(f"/node/{nid}?session_id={sid}").json()
    assert "works" in nd
    m = client.get(f"/metrics?session_id={sid}").json()
    assert "summary" in m and "nodes" in m


@pytest.mark.parametrize("kind,fmt", [
    ("image", "png"), ("image", "svg"), ("gexf", "gexf"),
    ("csv_nodes", "csv"), ("csv_edges", "csv"), ("metrics", "xlsx"),
])
def test_exports(kind, fmt):
    sid = configured_demo()
    g = client.get(f"/graph?session_id={sid}").json()
    r = client.post("/export", json={
        "session_id": sid, "kind": kind, "format": fmt,
        "view": {"nodes": g["nodes"], "edges": g["edges"]},
        "unit_singular": "traduction", "unit_plural": "traductions"})
    assert r.status_code == 200 and len(r.content) > 0


def test_chronology_export_honors_unit():
    """L'export Chronologie reçoit et honore le nom d'unité (comme les autres
    exports) : le rappel « chaque point = un <unité> » figure dans le SVG."""
    sid = configured_demo()
    chrono = client.get(f"/chronology?session_id={sid}").json()
    r = client.post("/export", json={
        "session_id": sid, "kind": "chronology", "format": "svg",
        "title": "Chronologie — Auteur", "view": chrono,
        "unit_singular": "traduction", "unit_plural": "traductions"})
    assert r.status_code == 200
    assert "Chaque point = un traduction" in r.content.decode("utf-8", "ignore")


def test_guard_key_equals_only_node():
    sid = client.get("/demo").json()["session_id"]
    client.get(f"/profile?session_id={sid}")
    r = client.post("/configure", json={
        "session_id": sid, "roles": {"Auteur": "node", "Titre": "edge"},
        "hinge_key": "Auteur"})
    assert r.status_code == 400 and "regrouper" in r.json()["detail"].lower()


def test_vo_vf_upload_and_group():
    f = DATA / "oeuvres_vo_vf_demo.xlsx"
    if not f.exists():
        pytest.skip("fichier VO/VF absent")
    up = client.post("/upload", files={"file": (f.name, f.read_bytes(),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}).json()
    sid = up["session_id"]
    client.get(f"/profile?session_id={sid}")
    roles = {"Œuvre": "node", "Titre": "edge", "Langue": "node", "Auteur": "node",
             "Traducteur": "node", "Éditeur": "node", "Année": "attribute"}
    cfg = client.post("/configure", json={"session_id": sid, "roles": roles,
                                          "hinge_key": "Œuvre"}).json()
    assert cfg["summary"]["n_works"] == 3          # 6 lignes fusionnées → 3 œuvres
    assert "Œuvre" not in cfg["summary"]["node_layers"]


def test_edge_endpoint_explains_link():
    sid = configured_demo()
    g = client.get(f"/graph?session_id={sid}").json()
    e = g["edges"][0]
    d = client.get("/edge", params={"session_id": sid,
                                    "source": e["source"], "target": e["target"]}).json()
    assert d["source_label"] and d["target_label"]
    assert "shared_via" in d and "shared_works" in d


def test_graph_connectors_param():
    sid = configured_demo()
    # lentille « via traducteur » : auteurs seuls, connecteur = Traducteur
    g = client.get(f"/graph?session_id={sid}&layers=Auteur&connectors=Traducteur").json()
    assert all(n["type"] == "Auteur" for n in g["nodes"])   # seuls les auteurs affichés


def test_lens_attrs_exposed_and_usable():
    sid = client.get("/demo").json()["session_id"]
    client.get(f"/profile?session_id={sid}")
    cfg = client.post("/configure", json={"session_id": sid, "roles": DEMO_ROLES}).json()
    assert "Genre" in cfg["summary"]["lens_attrs"]          # attribut proposé comme lentille
    # auteurs reliés via l'attribut Genre (sans connecteur de type)
    g = client.get("/graph", params={"session_id": sid, "layers": "Auteur",
                                      "connectors": "", "connector_attrs": "Genre"}).json()
    assert all(n["type"] == "Auteur" for n in g["nodes"])
    assert len(g["edges"]) > 0                              # le genre relie des auteurs


def test_unknown_session_404():
    assert client.get("/graph?session_id=inexistant").status_code == 404


def test_session_cap_evicts():
    for _ in range(M.MAX_SESSIONS + 5):
        client.get("/demo")
    assert len(M.SESSIONS) <= M.MAX_SESSIONS


def test_upload_too_large(monkeypatch):
    monkeypatch.setattr(M, "MAX_UPLOAD_MB", 0)        # tout dépasse → rejet
    r = client.post("/upload", files={"file": ("x.xlsx", b"abcdef", "application/octet-stream")})
    assert r.status_code == 413
