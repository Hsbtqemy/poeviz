# CLAUDE.md — Cartographie interactive de métadonnées (livres / traductions)

> Brief de construction pour Claude Code. Lis ce fichier en entier avant d'écrire la moindre ligne.
> Objectif de cette session : produire **un prototype complet et fonctionnel en une fois**, lançable en local.

---

## 1. Ce qu'on construit

Un outil web **générique** qui transforme un tableur Excel de métadonnées (livres, parutions, traductions) en une **cartographie interactive en réseau** : les entités (auteurs, traducteurs, éditeurs, langues, lieux…) deviennent des nœuds, reliés selon les ouvrages qu'ils partagent. L'utilisateur explore, filtre, recompose et exporte la carte.

**Générique = non lié à un fichier précis.** L'outil ingère n'importe quel `.xlsx` de structure raisonnable. Il détecte les colonnes, propose des rôles, et laisse l'utilisateur ajuster. Ne code RIEN en dur pour un jeu de données particulier.

**Principe directeur, à respecter partout : ne rien figer qui puisse être rendu réglable.** Le choix des entités, l'axe d'organisation, le comportement des liens, les couches visibles, le mode d'affichage — tout est exposé comme paramètre.

Un fichier de démonstration `data/traductions_demo.xlsx` est fourni (traductions franco-roumaines). Sers-t'en pour tester, **jamais** comme hypothèse en dur.

---

## 2. Stack imposée (ne pas dévier)

- **Backend** : Python 3.11+, **FastAPI** + Uvicorn.
  - `pandas` + `openpyxl` (lecture Excel)
  - `networkx` (graphe maître + métriques)
  - `python-louvain` (`community`) pour les communautés ; fallback `networkx.community.greedy_modularity_communities` si indispo.
- **Frontend** : **Sigma.js v3** + **graphology** (rendu WebGL du réseau), HTML/CSS/JS vanilla (pas de framework lourd type React, garder simple et lisible).
  - Layout force-directed : `graphology-layout-forceatlas2`.
- **Export image** : côté backend, **matplotlib** redessine la vue courante (positions reçues du front) en PNG 300 DPI + SVG.
- **Données échangées** : JSON via l'API.

Pas de base de données : tout vit en mémoire côté serveur le temps de la session (un graphe maître par fichier uploadé, gardé dans un cache en mémoire indexé par un id de session).

---

## 3. Architecture (le cœur — lis attentivement)

### 3.1 Le graphe maître
À l'upload, le backend construit **un seul graphe networkx complet** contenant TOUTES les entités possibles (toutes les colonnes-nœuds) + l'ouvrage comme nœud-charnière, avec tous les liens. Ce graphe maître ne change jamais après construction.

Toutes les vues affichées sont des **projections** de ce graphe : activer/masquer une couche, changer de pivot, masquer le nœud-charnière = filtrage/projection à la volée, **sans reconstruire** le graphe. C'est ce qui rend les changements instantanés.

### 3.2 Les trois rôles d'une colonne
Chaque colonne du tableur reçoit un rôle, modifiable à tout moment :
- **node** : la colonne devient un type d'entité affiché (chaque valeur unique = un nœud).
- **edge** : la colonne relie les nœuds sans être affichée (typiquement le titre du livre relie auteur↔traducteur↔éditeur de la même ligne).
- **attribute** : la colonne enrichit la fiche d'un nœud, sans peser sur le graphe (année, genre, lieu, réédition…).
- **ignore** : non utilisée.

Changer un rôle reconfigure la projection. Le même champ peut être node, edge ou attribute selon le choix → cartes différentes depuis la même donnée.

### 3.3 Profilage automatique (suggestion de rôles)
Au chargement, pour chaque colonne calcule : type (texte/nombre/date), nombre de valeurs uniques, taux d'unicité (uniques/lignes). Heuristique de suggestion :
- taux d'unicité très élevé (≈1, ex. Titre) → **edge** candidate.
- taux faible/moyen avec valeurs répétées (ex. Auteur, Traducteur, Éditeur) → **node** candidate.
- numérique ou catégoriel court (Année, Genre, Lieu, Réédition) → **attribute** par défaut.
L'utilisateur peut tout changer. Affiche le taux d'unicité dans l'UI pour l'aider.

### 3.4 Valeurs multiples dans une cellule
Gère les séparateurs courants dans une même cellule : `;` `,` `&` ` et ` ` and `. Une cellule « X & Y » crée deux entités reliées au même ouvrage. Rends la liste des séparateurs configurable (constante en haut du module, simple à éditer).

### 3.5 Projection & liens-charnières
Quand une couche-charnière (ex. le nœud-ouvrage, ou un type masqué) est retirée, deux comportements possibles, **réglable par l'utilisateur** :
- **report** (défaut) : les nœuds qui étaient reliés *via* l'élément masqué sont reliés directement entre eux (projection).
- **cut** : le lien disparaît, la carte se déconnecte.

### 3.6 Pivot (« organiser autour de »)
Sélecteur listant **dynamiquement** les colonnes actuellement en rôle node, + une option « aucun pivot » (force libre). Deux modes, **réglables** :
- **reorganize** : le pivot influence la disposition spatiale (le pivot et ses voisins se réorganisent autour).
- **filter** : le pivot ne fait que centrer/mettre en évidence, la disposition reste stable.

---

## 4. Analyse réseau (backend)
Sur le graphe **projeté** courant, calcule et expose via l'API :
- degré, centralité d'intermédiarité, centralité de vecteur propre,
- communautés (Louvain), avec un id de cluster par nœud (→ couleur),
- composantes connexes, densité, nombre de nœuds/arêtes,
- top N nœuds par centralité (« pivots »).
La taille d'un nœud encode une centralité (par défaut le degré) ; la couleur encode le type d'entité OU la communauté (togglable).

---

## 5. Frontend — comportements attendus

### 5.1 Disposition générale (3 zones)
- **Barre latérale gauche** : recherche ; « organiser autour de » (pivot) ; couches (toggles on/off par type d'entité, avec pastille de couleur) ; section repliée « Options avancées » (report/cut des liens ; mode pivot reorganize/filter ; choix du layout ; densité des étiquettes toutes/pivots/aucune ; couleur par type/communauté).
- **Canvas central** : le réseau Sigma.js. En haut : curseur temporel (plage d'années) + boutons Exporter / (Partager, peut être un stub). En bas : ligne d'aide discrète.
- **Panneau de détail droit** : masqué par défaut, glisse à l'ouverture quand on clique un nœud. Affiche les attributs du nœud, ses stats (centralité, communauté), et la liste de ses ouvrages liés.

Reproduis l'esprit des maquettes fournies dans `design/` (captures PNG + HTML). Palette sobre : fond crème clair, encre sombre, accents vert (#1D8A68) / ambre (#C07A1A) / rouge sélection (#B8453F). Lis `design/frontend-notes.md`.

### 5.2 Interactions réseau
- Clic sur un nœud → sélection : son voisinage s'illumine (arêtes + voisins en évidence), le reste s'estompe ; le panneau de détail s'ouvre.
- Survol → tooltip léger (nom + type).
- **Niveau de détail selon le zoom** : dézoomé = points colorés ; zoom intermédiaire = points + étiquettes ; zoom rapproché = nœuds-« cartes » (petite carte avec titre + 2-3 infos). Plus un réglage global **forçage** : auto / toujours points / toujours cartes. Plus **épinglage** d'une carte sur un nœud précis.
- Recherche → filtre/centre sur les nœuds correspondants.
- Curseur temporel → ne montre que les ouvrages (et entités/liens dérivés) dans la plage d'années choisie ; le réseau se recompose. Les positions des nœuds restent stables d'une plage à l'autre (ne pas relancer un layout complet à chaque cran : calcule les positions une fois sur le graphe complet, réutilise-les).

### 5.3 Cohérence écran ↔ export
Les **positions des nœuds** sont calculées une fois et **partagées** : l'image exportée (matplotlib, backend) reçoit ces positions et redessine la vue courante (mêmes positions, mêmes couleurs/clusters, mêmes filtres). L'export ne doit pas avoir une disposition différente de l'écran.

---

## 6. Exports
Bouton Exporter → options réglables au moment du clic :
- **périmètre** : tout le graphe / voisinage du nœud sélectionné (N sauts) / ce qui passe les filtres actifs.
- **format** : PNG 300 DPI (défaut) / SVG / PDF.
- **dimensions** (préréglages : pleine page, colonne) et **densité des étiquettes**.
Aussi : export **GEXF** (pour rouvrir dans Gephi), export **CSV nœuds + CSV arêtes**, export **CSV/XLSX des métriques**. (Le HTML autonome interactif est un bonus, optionnel si le temps manque.)

Destination première des images : **intégration dans Word** → PNG net + SVG vectoriel sont prioritaires, pas de JPEG.

---

## 7. API (esquisse, adapte si besoin mais garde REST clair)
- `POST /upload` (xlsx) → `{session_id, sheets[]}`
- `GET /profile?session_id&sheet` → colonnes + type + unicité + rôle suggéré
- `POST /configure` `{session_id, roles{col:role}, separators?}` → construit le graphe maître, renvoie un résumé
- `GET /graph?session_id&pivot&layers&link_mode&color_by&year_min&year_max` → nœuds+arêtes projetés (avec positions, taille, couleur, cluster) pour Sigma
- `GET /node/{id}?session_id` → détail d'un nœud (attributs, stats, ouvrages liés)
- `GET /metrics?session_id&...` → tableau des métriques
- `POST /export` `{session_id, view_state, scope, format, dimensions, labels}` → fichier

---

## 8. Structure de projet attendue
```
.
├── CLAUDE.md
├── README.md                # comment lancer (cf. §10)
├── requirements.txt
├── data/traductions_demo.xlsx
├── design/                  # maquettes de référence (fournies)
├── backend/
│   ├── main.py              # app FastAPI + routes
│   ├── ingest.py           # lecture xlsx, profilage, valeurs multiples
│   ├── graph.py            # graphe maître, projection, pivot, liens report/cut
│   ├── analysis.py         # centralités, communautés, stats
│   └── export.py           # rendu matplotlib PNG/SVG/PDF + GEXF/CSV
└── frontend/
    ├── index.html
    ├── app.js              # logique UI + appels API + Sigma
    ├── render.js           # Sigma/graphology : LOD points/cartes, highlight
    └── styles.css
```

---

## 9. Étapes de construction (suis cet ordre, teste à chaque palier)
1. Scaffolding : arborescence, `requirements.txt`, FastAPI qui sert le frontend statique + un `/health`.
2. `ingest.py` : upload + lecture xlsx + profilage + valeurs multiples. Test sur le démo.
3. `graph.py` : graphe maître depuis les rôles ; projection (couches, pivot, report/cut). Test : compte nœuds/arêtes attendus.
4. `analysis.py` : centralités + Louvain + stats.
5. API complète (`/configure`, `/graph`, `/node`, `/metrics`).
6. Frontend : layout 3 zones + chargement d'un fichier + rendu Sigma basique (points).
7. Interactions : sélection + highlight voisinage + panneau détail.
8. LOD points→étiquettes→cartes + forçage + épinglage.
9. Couches, pivot, options avancées, curseur temporel câblés à l'API.
10. `export.py` + bouton export paramétrable (positions partagées). 
11. README + passe de polish UI (cf. design/).

---

## 10. Critères de validation (le prototype est « fini » quand)
- `pip install -r requirements.txt` puis une commande unique lance le tout (documente-la dans le README ; un `uvicorn backend.main:app --reload` qui sert aussi le front est l'idéal).
- Je peux uploader `data/traductions_demo.xlsx`, voir les rôles suggérés, les ajuster, et obtenir une carte.
- Je peux : changer le pivot, masquer/afficher des couches, basculer report/cut, chercher un nœud, cliquer pour voir le panneau, déplacer le curseur temporel, et tout réagit.
- Les nœuds passent de points à cartes selon le zoom, et je peux forcer le mode.
- Je peux exporter un PNG 300 DPI net dont la disposition correspond à l'écran, + un SVG, + un GEXF.
- Aucune valeur en dur spécifique au fichier démo : un autre xlsx de structure comparable marche aussi.

---

## 11. Style de code
- Python typé (type hints), fonctions courtes, commentaires là où la logique de projection est subtile.
- Frontend lisible, sans dépendances superflues ; charge Sigma/graphology via CDN ou npm au choix, documente-le.
- Messages d'UI en français, clairs, sans jargon (« organiser autour de », pas « pivot de projection »).
- Gère les cas vides (cellule vide, colonne sans valeurs répétées, fichier sans en-têtes) proprement, avec messages utiles.

Construis maintenant, étape par étape, en vérifiant chaque palier. Va jusqu'à un prototype complet et lançable.
