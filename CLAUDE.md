# CLAUDE.md — Cartographie interactive de métadonnées (livres / traductions)

> Brief de construction pour Claude Code. Lis ce fichier en entier avant d'écrire la moindre ligne.
> Objectif de cette session : produire **un prototype complet et fonctionnel en une fois**, lançable en local.

---

## 1. Ce qu'on construit

Un outil web **générique** qui transforme un tableur Excel de métadonnées (livres, parutions, traductions) en une **cartographie interactive en réseau** : les entités (auteurs, traducteurs, éditeurs, langues, lieux…) deviennent des nœuds, reliés selon les ouvrages qu'ils partagent. L'utilisateur explore, filtre, recompose et exporte la carte.

**Générique = non lié à un fichier précis.** L'outil ingère n'importe quel `.xlsx` de structure raisonnable. Il détecte les colonnes, propose des rôles, et laisse l'utilisateur ajuster. Ne code RIEN en dur pour un jeu de données particulier.

**Principe directeur, à respecter partout : ne rien figer qui puisse être rendu réglable.** Le choix des entités, l'axe d'organisation, le comportement des liens, les couches visibles, le mode d'affichage, **le nom de l'unité-charnière** — tout est exposé comme paramètre.

**Terminologie.** Une *ligne* du tableur devient un nœud-charnière qui relie les entités qu'elle contient. Son nom affiché est **réglable** à la configuration (défaut « objet / objets », ou dérivé du nom de la feuille — « traduction », « film »…) et apparaît partout : interface et exports. Dans ce brief, écrit autour de la démo de traductions, on l'appelle souvent « ouvrage » : c'est l'exemple, **pas une valeur figée** (cf. §3.7).

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

Pas de base de données : tout vit en mémoire côté serveur le temps de la session (un graphe maître par fichier uploadé, gardé dans un cache en mémoire indexé par un id de session). Garde-fous (constantes en tête de `backend/main.py`) : sessions **plafonnées avec éviction LRU** (`MAX_SESSIONS`), **taille d'upload limitée** (`MAX_UPLOAD_MB`), et **métriques mises en cache par signature de projection** (`MAX_METRICS_CACHE`) pour ne pas relancer Louvain/centralités à chaque interaction.

Tests : `pip install -r requirements-dev.txt` puis `pytest` (suite dans `tests/` — ingestion, projections, garde-fous, API de bout en bout).

---

## 3. Architecture (le cœur — lis attentivement)

### 3.1 Le graphe maître
À l'upload, le backend construit **un seul graphe networkx complet** contenant TOUTES les entités possibles (toutes les colonnes-nœuds) + la ligne du tableur comme nœud-charnière (l'« ouvrage » ; nom réglable, cf. §3.7), avec tous les liens. Ce graphe maître ne change jamais après construction.

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

### 3.7 Nom de la charnière (réglable)
Le nœud-charnière = une ligne du tableur. Son **nom affiché** se règle à la configuration : un seul champ (le singulier), le pluriel est **dérivé** (recalculé côté serveur). Défaut « objet / objets » ; si le nom de la feuille est parlant (« Traductions »), il est **pré-suggéré** (« traduction / traductions »). Ce nom remplace « ouvrage » **partout** : pied de barre latérale, panneau de détail, cartes, tooltips, toggle charnière, et exports (image, petits multiples, libellé de l'axe temporel).

Constantes et heuristiques en tête de `ingest.py`, faciles à éditer : `DEFAULT_UNIT`, `GENERIC_SHEET_NAMES`, `pluralize_fr`, `singularize_fr`, `default_unit_label`. La pluralisation auto gère les cas courants (`+s`, `-eau/-au/-eu → -x`) ; les irréguliers (`-al → -aux`) ne sont pas couverts — on pourra rajouter un champ « pluriel » optionnel (le backend accepte déjà `unit_plural` explicite).

### 3.8 Regrouper des lignes (clé d'identité de charnière)
Par défaut, **une ligne = une charnière** (identité = numéro de ligne). On peut désigner une colonne comme **clé d'identité** (`hinge_key`) : les lignes partageant la même valeur **fusionnent en une seule charnière**. Cas d'usage : un livre en VO et sa traduction (deux lignes, même œuvre) → ils deviennent **un seul nœud-charnière** qui relie toutes leurs entités (auteurs, langues, traducteur, éditeurs), sans nœud-identifiant parasite à l'écran (la charnière est masquée par défaut).

Détails : la colonne-clé est **consommée par l'identité** (exclue des rôles, jamais affichée comme entité). À la fusion, le label cumule les valeurs-lien (les deux titres), l'année prend la **plus ancienne** (première parution), les attributs cumulent leurs valeurs distinctes. `n_works` compte les charnières réelles (pas les lignes). Construit dans `graph.build_master_graph(..., hinge_key=...)`, exposé via `hinge_key` dans `/configure` et le résumé.

> Alternative **sans regroupement** : laisser la colonne-clé en rôle **nœud** puis **masquer sa couche** — en mode *report* elle relie ses voisins en coulisses, sans s'afficher. Plus souple (chaque ligne garde sa propre année), mais il faut penser à masquer la couche.
>
> À ne pas confondre avec le futur rôle **« relation »** (lien dirigé et étiqueté entité→entité) : ici on **fusionne** des lignes, on ne crée pas de flèche.

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
- **Niveau de détail selon le zoom** : dézoomé = points colorés ; zoom intermédiaire = points + étiquettes ; zoom rapproché = nœuds-« cartes » (petite carte avec titre + 2-3 infos). Plus un réglage global **forçage** : auto / toujours points / toujours cartes. Plus **épinglage** d'une carte sur un nœud précis. Les **champs affichés sur la carte d'une charnière** (livre) sont **réglables à la volée** (cases à cocher en Options avancées) : `/graph` joint toutes les valeurs possibles du nœud-charnière (entités liées par type + attributs + année) dans `node.card`, le front choisit lesquelles montrer (`NetView.setCardFields`).
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
- `GET /profile?session_id&sheet` → colonnes + type + unicité + rôle suggéré + `suggested_unit` (nom de ligne dérivé de la feuille)
- `POST /configure` `{session_id, roles{col:role}, separators?, unit_singular?, unit_plural?, hinge_key?}` → construit le graphe maître, renvoie un résumé (incluant `unit_singular`/`unit_plural`/`hinge_key`)
- `GET /graph?session_id&pivot&layers&link_mode&color_by&year_min&year_max` → nœuds+arêtes projetés (avec positions, taille, couleur, cluster) pour Sigma
- `GET /node/{id}?session_id` → détail d'un nœud (attributs, stats, ouvrages liés)
- `GET /metrics?session_id&...` → tableau des métriques
- `POST /export` `{session_id, view_state, scope, format, dimensions, labels, unit_singular?, unit_plural?}` → fichier

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
