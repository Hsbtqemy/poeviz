# Roadmap — Filtres, Statistiques (« traits saillants ») & Parcours

> Issu d'une session de conception amont (juin 2026). On ajoute une **seconde
> famille de rendus** du graphe maître : à côté de la carte, des **statistiques**
> et des **parcours**. Rien de neuf dans le graphe maître — ce ne sont que de
> nouvelles façons de *restreindre*, *résumer* et *parcourir* la même projection.

## Vision

Tout part d'**un seul substrat** : le graphe maître biparti (entités ── charnières)
et sa **projection courante** (couches, pivot, années, connecteurs). La carte n'en
est qu'**un rendu**. Les quatre retours utilisateurs ne sont pas quatre features
indépendantes mais **deux opérations sur ce substrat**, plus deux correctifs :

| Opération | Tickets |
|---|---|
| **Restreindre** la projection | T1 (filtres) |
| **Résumer / reformuler** sous une autre forme | T2–T3 (stats), T6 (texte/exports) |
| **Parcourir** les liens reconnus | T4–T5 (parcours, sérendipité) |
| (Réparer les commandes de projection existantes) | T0 |

**Les trois mots de l'utilisateur nomment les trois modes d'entrée** dans les stats :

| Mot | Mode | Portée |
|---|---|---|
| **Approfondissement** | recensement | **base entière** (ignore les filtres) |
| **Exploration** | stats de ce que je regarde | **vue courante** (suit les filtres, couplée à la carte) |
| **Découverte** | bouton « Au hasard » | tirage / **marche aléatoire** |

## Principe central : la salience est **générique**

> Décision forte de la session : **ne pas** caler les stats sur des questions de
> domaine (« top traducteurs », « paires auteur-traducteur »…). La page doit faire
> **ressortir les traits saillants quels que soient le fichier et les champs.**

Un trait saillant = **un objet qui s'écarte de ses pairs**. Le calcul ne connaît
jamais le *nom* d'une colonne, seulement son **rôle** (nœud / attribut / temps),
que le profileur ([ingest.py](../backend/ingest.py)) détermine déjà. Un autre
`.xlsx` fait donc ressortir *ses* traits à lui, sans une ligne codée en dur.

## Garde-fous (tout ticket les respecte)

1. **Générique, rien en dur.** La salience se calcule à partir des **rôles**, jamais
   de noms de colonnes. Aucune vue ne suppose le jeu de données démo.
2. **Local, confidentiel.** Tout calcul *et* toute génération de texte se font sur le
   serveur ; **aucun appel externe** ; on ne logue pas le contenu des tableurs.
3. **Texte factuel, pas de plume.** L'outil pose la **donnée brute** ; la rédaction
   appartient à l'analyste. Le texte est généré par **gabarits déterministes**
   (« *« X » est reliée à 23 {unité}, soit 3× la médiane de son type.* »), jamais
   par une IA. *(Si un jour on veut de la prose, c'est un autre chantier : modèle
   local hébergé — cf. garde-fou 2.)*
4. **Projection partagée.** Les filtres vivent au **niveau projection**, consommés
   par carte + stats + parcours → cohérence écran ↔ stats ↔ export (même invariant
   que [roadmap-placement](roadmap-placement.md) §Garde-fous).
5. **Réglable, pas figé.** Filtres, portée (vue courante / base), signaux affichés,
   champs des fiches : tout exposé en contrôle UI + paramètre API.
6. **Tests.** Backend couvert par `pytest` ; rendu (page stats, surlignage parcours)
   validé **visuellement** → chaque ticket front liste ses vérifications manuelles.

---

## État des lieux — l'acquis réutilisable

| Fondation existante | Où | Réutilisée par |
|---|---|---|
| `compute_metrics` : degré, intermédiarité, vecteur propre, communautés, densité, composantes, `top_central` | [analysis.py:33](../backend/analysis.py#L33) | T2, T3 |
| Intermédiarité échantillonnée (gros graphes) — déjà robuste | [analysis.py:82](../backend/analysis.py#L82) | T2 (passeurs) |
| Poids d'arête (= ouvrages partagés) émis dans `/graph` | [main.py](../backend/main.py) | T2 (co-occurrences), T4 |
| `entities_by_type` / `node_detail` / `work_card` / `all_work_cards` | [graph.py](../backend/graph.py) | T3 (fiche), T4 (étapes) |
| `/edge` → `edge_detail` : *pourquoi* deux nœuds sont reliés (ouvrages communs + intermédiaires) | [main.py](../backend/main.py), [graph.py](../backend/graph.py) | T4 (chaînons du parcours) |
| Endpoint `/metrics` | [main.py](../backend/main.py) | T3 |
| Filtre année (`year_min/max`) dans `project()` + `/graph` *(le patron de filtre à généraliser)* | [graph.py](../backend/graph.py), [main.py](../backend/main.py) | T1 |
| Panneau de détail (fiche) + surlignage du voisinage | [app.js](../frontend/app.js), [render.js](../frontend/render.js) | T4 (départ + surlignage du chemin) |
| Chaîne export matplotlib PNG/SVG + CSV/XLSX/GEXF | [export.py](../backend/export.py) | T6 |
| Palette catégorielle de communautés | [analysis.py:24](../backend/analysis.py#L24) | T3 (couleur clusters) |
| Profileur : type / rôle / unicité par colonne | [ingest.py](../backend/ingest.py) | T2 (sait quel champ est nœud/attribut/temps) |
| Cache métriques par **signature de projection** + sessions LRU | [main.py](../backend/main.py) | T1, T2 (la salience se met en cache pareil) |

**Lecture** : T0 et T4 sont surtout de l'**assemblage d'acquis** (fiche, surlignage,
`/edge` existent déjà) ; T2 est une **agrégation neuve** par-dessus `compute_metrics` ;
T1 **généralise** le filtre année ; T3 est le gros morceau d'UI.

---

## Vue d'ensemble des tickets

| # | Titre | Dépend de | Effort | Risque |
|---|---|---|---|---|
| **T0** | Correctifs rapides : header masqué par la fiche + pivot réactif | — | S | Faible |
| **T1** | Socle : filtres au niveau projection (carte + stats + parcours) | — | M | Moyen (colonne vertébrale) |
| **T2** | Backend : agrégats de **salience** génériques | T1 | M | Moyen |
| **T3** | Page **Statistiques** : « Ce qui ressort » + exploration par grain | T1, T2 | L | Moyen |
| **T4** | **Parcours dirigé** : la fiche comme point de départ d'un chemin | T1 | M | Moyen |
| **T5** | **Sérendipité** : « Au hasard » / marche aléatoire | T4 | S | Faible |
| **T6** | **Synthèse textuelle & exports** (tableaux / images / texte) | T2, T3, T4 | M | Faible |

**Jalons** : *Correctifs* (T0) → *Socle filtres* (T1) → *Statistiques* (T2+T3) →
*Parcours & découverte* (T4+T5) → *Exports & texte* (T6). Chaque jalon est livrable seul.

---

## T0 — Correctifs rapides : header masqué + pivot réactif

**But.** Deux défauts ciblés remontés à l'essai sur données réelles. Indépendants du
reste, peu coûteux → à faire en premier (frustration immédiate levée).

**Scope.**
- **Header recouvert par la fiche.** `.detail` est `position:absolute; top:0; z-index:20`
  ([styles.css:292](../frontend/styles.css#L292)) → il passe par-dessus la `.topbar`
  ([styles.css:172](../frontend/styles.css#L172), sans z-index), dont le bouton Exporter
  est à droite. **Fix** : remonter `.topbar` au-dessus (`z-index:25` + fond opaque) → le
  panneau se glisse dessous, Exporter reste cliquable. *(La `.focus-bar` contourne déjà
  ainsi le panneau.)*
- **Pivot non réactif.** `buildPivotList()` lit `State.summary.node_layers`, **figé à la
  configuration** ([app.js:359](../frontend/app.js#L359), [:369](../frontend/app.js#L369)) ;
  quand on promeut une couche en « affiché » via la lentille 3 états (`cycleLayer`,
  [app.js:476](../frontend/app.js#L476)), la liste pivot n'est pas reconstruite. **Fix** :
  reconstruire la liste depuis les couches **actuellement affichées** (`State.layersOn`) à
  chaque cycle ; retirer un pivot dont le type n'est plus affiché ; corriger `setPivot`
  ([app.js:458](../frontend/app.js#L458)) qui indexe encore `node_layers`.

**Hors-scope.** Tout le reste de la roadmap. Pas de refonte de la liste pivot en `<select>`
(le style boutons-épingles reste — c'est la **réactivité** qui manque, pas la forme).

**Touchpoints.** `styles.css` (`.topbar`), `app.js` (`buildPivotList`, `setPivot`, `cycleLayer`).

**Critères d'acceptation.**
- Fiche ouverte (clic nœud *et* mode focalisation) → bouton Exporter toujours cliquable.
- Promouvoir une couche info→nœud via la lentille → elle **apparaît aussitôt** dans
  « organiser autour de », sans repasser par la configuration.
- Masquer un type qui était pivot → le pivot retombe proprement sur « Aucun ».

---

## T1 — Socle : filtres au niveau projection

> **État : livré.** Deux filtres au niveau projection, dans la signature de cache, sans
> relayout (positions stables) : **degré minimum** (`ProjectionParams.degree_min` +
> `graph.filter_min_degree`, une passe sans cascade) et **facettes par attribut**
> (`ProjectionParams.facets` + `graph.facet_options`/`works_passing_facets` ; colonnes
> attribut à faible cardinalité, hors colonne temps ; OR dans une colonne, ET entre
> colonnes). Front : section « Filtres » (curseur + groupes repliables de cases). Param
> `/graph` : `degree_min`, `facets` (JSON). Exposé via `summary.facets` à `/configure`.
> Couvert par `test_filter_min_degree_hides_low_degree` et `test_facets_filter_by_attribute_value`.

**But.** Un **filtrage par contenu**, construit là où il doit l'être — dans la
**projection**, pas dans la carte — pour que **carte, stats et parcours** lisent le
**même état filtré**. C'est la fondation des stats « vue courante ».

**Acquis.** Le filtre année (`year_min/max`) traverse déjà `project()` et `/graph` : c'est
**le patron exact à généraliser** (un critère qui restreint l'ensemble des charnières/nœuds
actifs avant projection, sans toucher au maître).

**Scope.**
- **Degré minimum** (curseur) : masque les nœuds sous un seuil de liens → enlève le bruit
  des hapax / isolés. Gros gain, petit code. Appliqué *après* projection (le degré dépend
  de la projection).
- **Facettes d'attribut** : pour une colonne en rôle attribut, cases par valeur → ne garder
  que les charnières dont l'attribut ∈ valeurs cochées. Multi-valué géré (séparateurs).
- Paramètres API ajoutés à la projection : `degree_min`, `facets` (dict `{col: [valeurs]}`),
  pris en compte dans la **signature de cache** (sinon métriques périmées).
- **Barre de filtres UI** réutilisable, posée une fois, **partagée** : la carte la consomme
  déjà via `/graph` ; T3 et T4 la liront telle quelle.

**Hors-scope.** Stats (T2/T3) ; recherche plein-texte (existe déjà, distincte).

**Touchpoints.** `graph.py` (`project` : application des filtres), `main.py` (`/graph`,
signature de cache), `app.js` (barre de filtres, état), `index.html`, `styles.css`.

**Critères d'acceptation.**
- Test pytest : `degree_min=2` retire exactement les nœuds à 0–1 lien de la projection.
- Test pytest : une facette sur un attribut connu restreint au bon sous-ensemble de charnières.
- Filtre actif → carte **et** métriques (`/metrics`) reflètent le même sous-ensemble.
- Vue par défaut inchangée tant qu'aucun filtre n'est posé (53/70 sur la démo).
- Filtres pris dans la signature de cache (deux filtres ≠ → deux entrées de cache).

---

## T2 — Backend : agrégats de salience génériques

**But.** Calculer « ce qui ressort » sur la projection courante, **à partir des rôles
seuls**. Brique backend qui alimente T3 (affichage) et T6 (texte).

**Acquis.** `compute_metrics` fournit déjà degré / intermédiarité / vecteur propre /
communautés / densité / composantes / `top_central` ([analysis.py:33](../backend/analysis.py#L33)).
La salience est surtout du **post-traitement** (écarts à la médiane) par-dessus.

**Scope — signaux, par grain** (chacun = objet + mesure d'écart, calculable sans connaître le domaine) :
- **Nœud — domination** : entité très au-dessus de la médiane de **son type** (liens,
  nombre d'ouvrages, centralité) → ratio / z-score.
- **Nœud — passeur** : forte intermédiarité relative au degré (relie des mondes séparés).
- **Arête — paire récurrente** : poids (ouvrages communs) très supérieur au poids typique.
- **Arête — pont** : seule arête entre deux communautés.
- **Graphe — communautés** : partition décrite par membres centraux + **valeur d'attribut
  dominante** du cluster.
- **Temps — pics & amplitudes** *(uniquement si une colonne date est détectée)* : année de
  pic, entités à plus large / étroite amplitude, entrées précoces / tardives.
- **Anomalies** : isolés, hapax, valeur d'attribut anormalement connectée.

- Endpoint `GET /salience?session_id&<projection>&scope=view|base` → liste de traits
  classés `{kind, grain, objet(s), mesure, valeur, contexte}` (structuré, prêt pour table
  *ou* texte). `scope=base` recalcule sur la projection non filtrée.
- **Cache** par signature de projection (même mécanisme que `/metrics`).

**Hors-scope.** Tout le front (T3) ; la mise en phrase (T6 consomme la structure).

**Touchpoints.** `analysis.py` (fonctions de salience), `main.py` (`/salience`, cache).

**Critères d'acceptation.**
- Test pytest sur la démo : le trait « domination » désigne bien l'entité au degré max de
  son type ; déterministe.
- Test : sur un `.xlsx` **sans** colonne date, aucun signal temporel n'est produit (pas de
  crash, pas de supposition).
- `scope=base` ignore les filtres ; `scope=view` les respecte.
- Chaque trait porte de quoi se rendre *et* se phraser (objet identifiable, valeur chiffrée).

---

## T3 — Page Statistiques : « Ce qui ressort » + exploration par grain

**But.** La page. **Salience-first** : on ouvre sur ce qui dépasse, puis on creuse par grain.
Couplée aux filtres T1 ; bascule **vue courante / base entière**.

**Croquis (forme, pas pixel-perfect) :**

```
┌───────────────────────────────────────────────────────────────────────┐
│  Statistiques     [ Vue courante ▾ | Base entière ]        [ Au hasard 🎲 ] │  ← T5
├──────────────┬────────────────────────────────────────────────────────┤
│ FILTRES (T1) │  CE QUI RESSORT                                         │
│  partagés    │  • « X » concentre 3× plus de liens que la médiane      │
│  avec la     │    de son type                       [voir carte][texte]│
│  carte       │  • paire X–Y : 12 ouvrages communs   [voir carte][texte]│
│              │  • passeur : Z relie 4 communautés                      │
│  ─ degré min │  • pic : 1965 (28 ouvrages)                             │
│  ─ facettes  │                                                         │
│    ▢ Revue A │  EXPLORER PAR GRAIN                                     │
│    ▢ Revue B │  [ Entités | Paires | Ouvrages | Ensemble ]            │
│    …         │  ┌─ tableau triable ─────────────────────────────────┐ │
│              │  │ entité      liens   ouvrages   centralité   commu. │ │
│              │  │ …                                                  │ │
│              │  └────────────────────────────────────────────────────┘│
│              │  [ exporter :  tableau ▾ | image | texte ]   ← T6      │
└──────────────┴────────────────────────────────────────────────────────┘
```

**Scope.**
- Route / vue « Statistiques » dans la même app (bascule carte ⇄ stats sur le **même état**).
- Bloc **« Ce qui ressort »** : consomme `/salience` (T2), une ligne par trait, chacune avec
  « voir sur la carte » (renvoie + surligne) et « texte » (T6).
- Bloc **explorer par grain** : onglets *Entités / Paires / Ouvrages / Ensemble*, tableaux
  **triables** (consomment `/metrics`, poids d'arête, `all_work_cards`, résumé).
- Interrupteur **vue courante / base entière** (passe `scope` à `/salience` et aux tables).
- Barre de filtres T1 réutilisée à gauche.

**Hors-scope.** Génération du texte et écriture des fichiers (T6) ; le tirage au sort (T5).

**Touchpoints.** `index.html` (zone stats), `app.js` (vue stats, bascule, appels), nouveau
`frontend/stats.js` si `app.js` devient trop gros, `styles.css`.

**Critères d'acceptation.**
- Filtrer sur la carte puis basculer en stats (vue courante) → mêmes nœuds pris en compte.
- « Base entière » → chiffres du recensement complet, filtres ignorés.
- Cliquer « voir sur la carte » d'un trait → retour carte avec l'objet surligné.
- Tables triables ; vide géré proprement (message utile, pas d'erreur).
- Un `.xlsx` non-démo produit une page cohérente (générique vérifié).

---

## T4 — Parcours dirigé : la fiche comme point de départ d'un chemin

**But.** Depuis une fiche, **cheminer de lien en lien** dans le réseau ; l'outil garde la
trace (fil d'Ariane). « L'idée la plus forte de la session » : unifie *exporter la fiche*,
*la navigation* et (via T5) *la découverte*.

**Acquis.** Fiche + surlignage du voisinage existent ([app.js](../frontend/app.js),
[render.js](../frontend/render.js)) ; `/edge` explique déjà *pourquoi* deux nœuds sont reliés
(→ légende d'un chaînon) ; `entities_by_type` / `node_detail` fournissent les sauts possibles.

**Scope.**
- Depuis une fiche (entité **ou** ouvrage), lister les **liens reconnus** = arêtes de la
  projection **courante** (donc déjà filtrée par T1). Cliquer un lien → fiche suivante.
- **Fil d'Ariane** accumulé : `Auteur A → [ouvrage X, 1965] → Traducteur B → [ouvrage Y] → Revue C`.
  Reculer / repartir / vider.
- Le parcours **est un objet** : il **s'illumine sur la carte** (la chaîne ressort, le reste
  s'estompe — réutilise le surlignage voisinage en mode chaîne) et se garde en état.
- Chaque chaînon est **explicable** via `/edge` (ouvrages communs, intermédiaire partagé).

**Hors-scope.** Marche aléatoire (T5) ; export texte du parcours (T6, mais le **modèle de
données** du parcours est défini ici pour que T6 le sérialise).

**Touchpoints.** `app.js` (état parcours, fil d'Ariane), `render.js` (surlignage en chaîne),
`index.html`/`styles.css` (le ruban de parcours), `main.py`/`graph.py` (réutilise `/edge`).

**Critères d'acceptation.**
- Partir d'une entité, faire 3 sauts → le fil affiche la chaîne exacte, dans l'ordre.
- Les sauts proposés se limitent aux **liens présents dans la projection filtrée**.
- La chaîne s'illumine sur la carte ; reculer revient à l'état précédent.
- Survol d'un chaînon → l'explication `/edge` (pas de chaînon anonyme).

---

## T5 — Sérendipité : « Au hasard » / marche aléatoire

**But.** La **découverte**. Le bouton « Au hasard » = le moteur de parcours (T4) lâché en
**marche aléatoire** sur les arêtes → un chemin inattendu entre entités sans rapport apparent.

**Acquis.** Moteur de parcours T4 ; déterminisme non requis ici (c'est *le* cas où l'aléa
est voulu — à isoler des chemins déterministes du reste du projet).

**Scope.**
- Bouton **« Au hasard »** (page stats *et* à côté de la fiche) :
  - **tirage simple** : un objet (entité / paire / ouvrage) au sort, ouvert en fiche, **situé**
    par rapport au reste (« dans la moyenne… mais reliée à ce passeur »).
  - **parcours au hasard** : marche aléatoire de N pas sur les arêtes de la projection → fil
    d'Ariane T4 rempli automatiquement.
- Tirage **franchement aléatoire** par défaut (la découverte, pas un top-N déguisé) ; respecte
  les filtres T1 (on explore ce qui est visible).

**Hors-scope.** Pondérer le tirage vers les nœuds « intéressants » (option ultérieure, à
discuter — risque de retomber dans le top-N).

**Touchpoints.** `app.js` (bouton, tirage), réutation de T4 ; `main.py` si le tirage est
fait côté serveur (sinon front pur sur les données de `/graph`).

**Critères d'acceptation.**
- « Au hasard » ouvre un objet **dans** la projection courante (jamais un nœud filtré).
- « Parcours au hasard » remplit un fil d'Ariane T4 valide (chaîne réellement connectée).
- Deux clics → deux résultats différents (l'aléa marche), sans erreur sur petit graphe.

---

## T6 — Synthèse textuelle & exports

> **Déjà livré (hors séquence, lot T0)** : périmètre d'export **« Vue courante, sélection
> en évidence »** — `render_image` honore une opacité par nœud (`alpha`) et une couleur/opacité
> par arête, le front les pose en miroir des reducers de `render.js` (sélection + voisinage
> vifs, reste estompé, arêtes incidentes en rouge). Incarne le §5.3 (cohérence écran↔export).
> **Reste** : tableaux par grain, graphiques (barres/histogramme/matrice), synthèse texte.

**But.** Sortir les stats et les parcours en **tableaux, images, et texte** — tout **local**.

**Acquis.** Chaîne matplotlib PNG/SVG + CSV/XLSX/GEXF ([export.py](../backend/export.py)) déjà
en place pour la carte → on l'étend aux graphiques de stats et on ajoute le **texte**.

**Scope.**
- **Tableaux** : CSV / XLSX des tables de grain (entités, paires, ouvrages, ensemble) et des
  métriques (réutilise l'export métriques existant).
- **Images / graphiques** : barres top-N, histogramme temporel, matrice de co-occurrence →
  PNG 300 DPI + SVG (chaîne matplotlib existante, mêmes couleurs/clusters que la carte).
- **Texte — synthèse des traits saillants**, par **gabarits déterministes** (garde-fou 3) :
  une phrase **factuelle et chiffrée** par trait (« *« X » est reliée à 23 {unité}, soit 3×
  la médiane de son type.* »), `{unité}` = nom de charnière réglable. Idem pour un **parcours**
  (T4) : la chaîne sérialisée en texte (« *A a écrit X (1965), traduit par B ; B a aussi
  traduit Y, paru dans C.* ») → l'analyste raconte, l'outil fournit la matière.
- **Exporter la fiche** (retour utilisateur 1-bis) : attributs + stats + ouvrages liés en
  CSV / texte.
- Endpoint d'export étendu (`/export` ou un `/export-stats`) ; respecte `unit_singular/pluriel`.

**Hors-scope.** Toute génération de **prose** rédigée (IA) — exclu par garde-fous 2 & 3.

**Touchpoints.** `export.py` (graphiques stats, gabarits texte), `main.py` (route export),
`app.js` (boutons d'export des nouvelles vues).

**Critères d'acceptation.**
- Export tableau d'un grain → CSV/XLSX ouvrable, colonnes cohérentes avec l'écran.
- Export image d'un graphique stats → PNG net + SVG, palette identique à la carte.
- Export texte d'un trait et d'un parcours → phrases factuelles, `{unité}` correctement
  substitué (singulier/pluriel), **aucun** appel réseau (vérif : tourne hors-ligne).
- Caractères accentués / roumains corrects (UTF-8) dans tous les formats.

---

## Risques transverses & décisions ouvertes

- **Généricité réelle (T2)** : le piège est une page calée *de fait* sur la démo. Test
  obligatoire sur un second `.xlsx` de structure différente (sans date, autres rôles).
- **Couplage filtres (T1)** : si les filtres ne sont pas dans la signature de cache, les
  stats affichent des chiffres périmés → critère d'acceptation explicite.
- **Texte factuel vs interprétation (T6)** : tenir la ligne « données brutes, pas de plume ».
  Toute tentation de phrase interprétative (« X *domine remarquablement* ») est hors-scope.
- **Aléa isolé (T5)** : le reste du projet est **déterministe** (`seed=42`, cohérence export).
  Le hasard ne doit vivre **que** dans T5, jamais contaminer positions / métriques / export.
- **Portée par défaut (T3)** : « vue courante » par défaut (cohérent avec la carte) ; « base
  entière » en un clic. À confirmer à l'usage.
