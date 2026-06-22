# Prompt de démarrage — à coller dans Claude Code

Copie-colle ce message à Claude Code une fois que `CLAUDE.md`, le dossier `data/` (avec `traductions_demo.xlsx`) et le dossier `design/` sont en place à la racine du projet.

---

Lis `CLAUDE.md` en entier avant tout. Tu vas construire le prototype complet qui y est décrit : un outil web générique de cartographie de métadonnées de livres, stack FastAPI + Sigma.js, avec graphe maître + projections, rôles de colonnes (node/edge/attribute), analyse réseau, interface à 3 zones, niveaux de détail point/carte, curseur temporel, et exports orientés Word (PNG 300 DPI + SVG + GEXF).

Procède dans l'ordre des étapes de la section 9, en testant à chaque palier avant de passer au suivant. Sers-toi de `data/traductions_demo.xlsx` pour tester, mais ne code aucune hypothèse en dur propre à ce fichier — l'outil doit rester générique.

Commence par me proposer rapidement (quelques lignes) ton plan d'attaque et l'arborescence que tu vas créer, puis lance-toi sur l'étape 1. Avance ensuite de façon autonome palier par palier jusqu'à un prototype lançable, en me signalant à chaque étape ce qui marche. Si une décision d'implémentation est ambiguë, choisis l'option la plus cohérente avec le principe directeur (« ne rien figer qui puisse être rendu réglable ») et signale-le, sans t'arrêter pour demander.

Objectif final : `pip install -r requirements.txt` puis une seule commande, et j'ai la carte dans mon navigateur.
