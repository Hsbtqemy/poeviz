# Comment ça marche — guide du fonctionnement

Ce document explique, de manière concrète mais accessible, **ce que fait le
programme du début à la fin**, **les technologies employées** à chaque étape, et
**la méthodologie** qui sous-tend l'ensemble. Il complète le [README](../README.md)
(prise en main) et le [CLAUDE.md](../CLAUDE.md) (brief de construction).

> En une phrase : on transforme un tableur Excel en un **réseau** où les entités
> (auteurs, traducteurs, éditeurs…) sont des points reliés selon ce qu'ils
> partagent, puis on laisse l'utilisateur explorer, filtrer et exporter cette carte.

---

## 1. Le trajet d'un fichier (vue d'ensemble)

```
  fichier.xlsx
      │  (1) dépôt + lecture
      ▼
   pandas ──► DataFrame  ──(2) profilage──►  rôles suggérés par colonne
      │                                              │
      │                          (3) l'utilisateur ajuste les rôles
      ▼                                              ▼
   (4) GRAPHE MAÎTRE biparti  (networkx)  ──────────┘
      │   entités ── lignes (la « charnière »)
      │
      │  (5) PROJECTION à la volée  (couches, pivot, report/cut, années)
      ▼
   graphe projeté ──(6) analyse──► centralités, communautés, densité
      │
      │  (7) positions calculées une fois, réutilisées
      ▼
   (8) RENDU réseau  (Sigma.js + graphology, WebGL)  ◄── l'écran
      │
      │  (9) export : les positions de l'écran repartent au backend
      ▼
   PNG 300 DPI / SVG / PDF (matplotlib) · GEXF · CSV
```

Le point important : **on construit le graphe complet une seule fois (étape 4)**.
Tout le reste — masquer une couche, changer de pivot, bouger le curseur des années —
n'est qu'un **filtrage** de ce graphe (étape 5), jamais une reconstruction. C'est ce
qui rend l'interface instantanée.

---

## 2. La stack en un coup d'œil

| Couche | Technologie | Rôle |
|---|---|---|
| Serveur web | **FastAPI** + **Uvicorn** | expose une API REST et sert le frontend |
| Lecture Excel | **pandas** + **openpyxl** | charge le `.xlsx` en tableau manipulable |
| Graphe & métriques | **networkx** | graphe maître, projection, centralités |
| Communautés | **python-louvain** (`community`) | regroupe les nœuds en clusters (repli networkx) |
| Export image | **matplotlib** | redessine la vue en PNG/SVG/PDF |
| Rendu réseau | **Sigma.js v3** + **graphology** | dessin WebGL du réseau dans le navigateur |
| Disposition | **graphology-layout-forceatlas2** | place les nœuds (force-directed) |
| Échange | **JSON** sur HTTP | tout passe par l'API REST |

**Pas de base de données.** Chaque fichier déposé vit **en mémoire** le temps de la
session, rangé dans un dictionnaire Python indexé par un `session_id`. Fermer le
serveur efface tout — c'est un outil d'exploration, pas un entrepôt.

Le frontend est en **HTML/CSS/JS vanilla** (aucun framework type React) ; les trois
librairies réseau sont chargées par **CDN** (jsDelivr), en build UMD.

---

## 3. Étape par étape

### 3.0 L'idée centrale (à comprendre avant tout)

Deux entités ne sont **jamais reliées directement dans les données**. Elles le
deviennent parce qu'elles apparaissent sur la **même ligne** du tableur. Une ligne
(un livre, un film, un contrat…) est une **charnière** : tout ce qu'elle contient
est « relié » par elle.

```
Auteur A ─┐
          ├─ [ligne 12]      ← la charnière
Auteur B ─┘
```

Ce nom de charnière est réglable (« objet » par défaut). Dans la suite on l'appelle
« ligne » ou « charnière ».

### 3.1 Dépôt et lecture — `backend/ingest.py`

L'utilisateur dépose un `.xlsx`. `pandas.read_excel(..., engine="openpyxl")` lit
**toutes les feuilles** en tableaux (`DataFrame`). On lit en `dtype=object` pour ne
pas laisser pandas transformer silencieusement « 2019 » en `2019.0`, et on nettoie
les en-têtes vides et les lignes entièrement vides.

> **Pourquoi pandas ?** Il gère l'irrégularité du monde réel (cellules vides, types
> mélangés, plusieurs feuilles) et donne un tableau propre sur lequel raisonner.

### 3.2 Profilage — `backend/ingest.py`

Pour **chaque colonne**, le programme mesure :
- le **type** (texte / nombre / date), déduit des valeurs ;
- le nombre de **valeurs uniques** et le **taux d'unicité** (uniques ÷ total) ;
- s'il s'agit d'une colonne d'**années** (pour le curseur temporel).

À partir de ces mesures, une **heuristique suggère un rôle** :
- taux d'unicité ≈ 1 (ex. un *titre*, presque toujours différent) → plutôt un **lien** ;
- taux faible/moyen avec répétitions (ex. *Auteur*, *Éditeur*) → plutôt un **nœud** ;
- numérique ou catégoriel court (ex. *Année*, *Genre*) → plutôt une **info**.

> **Méthodologie : suggérer, pas décider.** Le profilage ne fait que pré-remplir.
> L'utilisateur garde la main, et le taux d'unicité est affiché pour l'aider à
> trancher. Rien n'est codé en dur pour un fichier précis : ce sont des seuils
> relatifs, réglables en tête de module.

### 3.3 Les rôles (et le nom de l'unité) — écran de configuration

Chaque colonne reçoit un des quatre rôles :

| Rôle | Effet |
|---|---|
| **Nœud** | la colonne devient un type d'entité affiché (chaque valeur = un point) |
| **Lien** | relie sans être affichée (typiquement le *titre*, qui nomme la ligne) |
| **Info** | enrichit la fiche d'un nœud (année, genre…) sans peser sur le graphe |
| **Ignoré** | non utilisée |

Le **même champ** peut devenir nœud, lien ou info → **des cartes différentes depuis
la même donnée**. On nomme aussi ici l'**unité-charnière** (une ligne) : un seul mot
au singulier, le pluriel est dérivé automatiquement.

Les cellules **multi-valeurs** sont gérées : « Hugo & Balzac » est découpé sur les
séparateurs courants (`;` `,` `&` ` et ` ` and `) et crée **deux** entités reliées à
la même ligne.

**Regrouper des lignes (optionnel).** Si plusieurs lignes décrivent la même chose (un
livre en VO et sa traduction…), on peut désigner une **colonne de regroupement** :
les lignes au même identifiant **fusionnent en une seule charnière**. Les deux
éditions sont alors reliées par construction, sans nœud-identifiant visible. (Détail
technique : l'identité de la charnière devient la valeur de la clé au lieu du numéro
de ligne — voir `hinge_key` dans [CLAUDE.md §3.8](../CLAUDE.md).)

### 3.4 Le graphe maître biparti — `backend/graph.py`

C'est le cœur. À la validation des rôles, on construit **un seul graphe networkx**
qui ne changera plus. Il est **biparti** : il n'y a que des arêtes
**entité ── ligne**.

- nœud entité : identifiant `"colonne::valeur"` (ex. `Auteur::Hugo`) ;
- nœud charnière : identifiant `"work::numéro_de_ligne"` ;
- arête : chaque valeur de chaque colonne-nœud est reliée à la ligne où elle apparaît.

```
Auteur::Hugo ───── work::12 ───── Éditeur::Plon
                       │
                  Traducteur::X
```

> **Pourquoi biparti, et pourquoi tout passer par la ligne ?** Parce que c'est la
> seule relation **vraie et générique** dans un tableur : « être sur la même ligne ».
> À partir de cette structure unique, on peut projeter **n'importe quel** réseau
> (co-auteurs, auteur↔éditeur, traducteur↔langue…) sans rien recâbler. (Détail dans
> le [CLAUDE.md §3](../CLAUDE.md).)

### 3.5 La projection — `backend/graph.py`, fonction `project()`

Tout ce qu'on voit à l'écran est une **projection** du graphe maître, calculée à la
volée selon les réglages :

- **Couches** : on ne garde que les types d'entités demandés.
- **Fenêtre temporelle** : on ne garde que les lignes dont l'année est dans la plage.
- **Charnière** : on peut afficher les lignes comme nœuds, ou les garder implicites.
- **report / cut** : quand un nœud qui servait de pont est masqué —
  - **report** (défaut) : on **reconstruit** la liaison (les voisins du nœud masqué
    sont reliés entre eux ; le poids de l'arête compte les lignes partagées) ;
  - **cut** : on ne reconstruit pas, le lien disparaît.

Concrètement, en mode *report*, on prend chaque groupe connexe de nœuds masqués et on
relie « en clique » ses voisins visibles. C'est une **projection de graphe biparti
vers un graphe à un mode**, technique classique en analyse de réseaux.

> **Méthodologie : projeter, pas reconstruire.** Le graphe maître est immuable ;
> changer un réglage ne fait que recalculer une projection. D'où l'instantanéité.

### 3.6 L'analyse réseau — `backend/analysis.py`

Sur le graphe **projeté** (jamais le maître), on calcule :
- trois **centralités** : degré, intermédiarité (*betweenness*), vecteur propre
  (*eigenvector*) — avec des replis robustes si le graphe est petit ou déconnecté ;
- les **communautés** par **Louvain** (`community.best_partition`), avec repli sur
  `greedy_modularity_communities` de networkx si la librairie manque ;
- **densité**, **composantes connexes**, **degré moyen**, et le **top 10** des nœuds
  les plus centraux (les « pivots »).

La **taille** d'un nœud encode une centralité (le degré par défaut) ; la **couleur**
encode le type d'entité, la communauté, ou l'époque — au choix.

### 3.7 Les positions, calculées une fois — `backend/graph.py`, `initial_positions()`

Les coordonnées des nœuds sont calculées **une seule fois** sur le graphe maître,
avec `networkx.spring_layout` (graine fixe `seed=42` → résultat reproductible), puis
réutilisées pour toutes les projections.

> **Pourquoi une seule fois ?** Pour que les nœuds **ne sautent pas** quand on bouge
> le curseur des années ou qu'on masque une couche. La carte reste lisible et stable
> dans le temps.

### 3.8 Le rendu — `frontend/render.js` (Sigma.js v3 + graphology)

Le navigateur reçoit les nœuds et arêtes en JSON et les dessine en **WebGL** via
**Sigma.js**, sur un graphe **graphology**. Une disposition **ForceAtlas2** affine
les positions reçues. Le rendu gère :

- le **niveau de détail selon le zoom** (LOD) : dézoomé = points colorés ; zoom
  intermédiaire = points + étiquettes ; zoom rapproché = petites **cartes** (titre +
  2-3 infos) — avec un mode forcé et l'**épinglage** d'une carte. Les **champs de la
  carte d'une charnière** (auteur, traducteur, année…) se choisissent à la volée
  (Options avancées) ;
- la **sélection** : cliquer un nœud illumine son voisinage et estompe le reste ;
- le **survol** (tooltip), le **déplacement** d'un nœud à la souris, et un mode
  **réseau temporel** où l'axe horizontal devient le temps.

> **Pourquoi WebGL ?** Pour rester fluide à plusieurs centaines/milliers de nœuds,
> là où du SVG/DOM ramerait.

### 3.9 Les exports — `backend/export.py`

Pour l'**image**, le frontend renvoie au backend les **positions exactes affichées à
l'écran** ; **matplotlib** (backend `Agg`, sans affichage) **redessine** la vue avec
ces mêmes positions, couleurs et filtres.

> **Méthodologie : cohérence écran ↔ export.** L'image n'est pas une capture, c'est
> un re-rendu fidèle. Ce qu'on voit est ce qu'on exporte — net, en 300 DPI pour
> l'intégration dans Word, ou en SVG vectoriel.

Autres sorties : **GEXF** (pour rouvrir dans Gephi), **CSV nœuds / arêtes**, et un
tableau de **métriques** (CSV/XLSX). Plus des vues dédiées exportables : **petits
multiples** (le réseau à plusieurs époques côte à côte) et **chronologie** (une ligne
par entité, ses lignes placées dans le temps).

---

## 4. La méthodologie, en 5 principes

1. **Générique avant tout.** Rien n'est codé en dur pour un fichier. Les seuils, les
   séparateurs, le nom de l'unité sont des constantes réglables, et tout est
   surchargeable depuis l'interface.
2. **Un seul graphe, des projections.** On construit le graphe complet une fois ;
   toutes les vues en sont des filtrages à la volée → réactivité instantanée.
3. **La co-occurrence comme relation.** « Être sur la même ligne » est la seule
   relation universelle ; le graphe biparti la matérialise et permet d'en projeter
   toutes les variantes.
4. **Positions stables.** Calculées une fois, réutilisées partout → pas de saut de
   nœuds quand on filtre.
5. **Suggérer, pas imposer.** Le programme propose (rôles, nom d'unité) ; l'humain
   décide. Le but est d'aider à lire la donnée, pas de la figer.

---

## 5. Glossaire express

- **Entité** : une valeur affichée comme nœud (un auteur, un éditeur…).
- **Charnière / ligne / « objet »** : une ligne du tableur, qui relie ses entités.
- **Graphe maître** : le graphe complet, biparti, construit une fois.
- **Projection** : une vue filtrée du graphe maître (ce qu'on voit à l'écran).
- **report / cut** : reconstruire ou couper les liens passant par un nœud masqué.
- **Pivot** : l'entité autour de laquelle on (ré)organise la carte.
- **Centralité** : à quel point un nœud est « important » (degré, intermédiarité…).
- **Communauté** : un groupe de nœuds fortement reliés (détecté par Louvain).
- **LOD** : niveau de détail du rendu selon le zoom (points → étiquettes → cartes).

---

## 6. Où regarder dans le code

| Pour comprendre… | Fichier |
|---|---|
| Lecture xlsx, profilage, découpe multi-valeurs | [`backend/ingest.py`](../backend/ingest.py) |
| Graphe maître, projection, report/cut, positions | [`backend/graph.py`](../backend/graph.py) |
| Centralités, communautés, densité | [`backend/analysis.py`](../backend/analysis.py) |
| Exports image / GEXF / CSV | [`backend/export.py`](../backend/export.py) |
| Routes API et sessions en mémoire | [`backend/main.py`](../backend/main.py) |
| État, appels API, câblage des contrôles | [`frontend/app.js`](../frontend/app.js) |
| Rendu Sigma, LOD, sélection, cartes | [`frontend/render.js`](../frontend/render.js) |
| Structure de l'interface (3 zones) | [`frontend/index.html`](../frontend/index.html) |
