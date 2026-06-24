# Roadmap — Moteur de placement unifié (A / B / C)

> Évolution de la **disposition** des nœuds. Aujourd'hui : *proximité = connectivité*,
> calculée par une force déterministe une seule fois ([graph.py `initial_positions`](../backend/graph.py),
> affinée par ForceAtlas2 dans [render.js `layout`](../frontend/render.js)). Cette
> roadmap ouvre trois stratégies de placement complémentaires **sans toucher au graphe
> maître** — ce ne sont que des façons de calculer `(x, y)` par nœud.

## Vision

Pas trois modules étanches, mais **un seul placeur paramétré**. Force, circulaire et
temporel deviennent des *presets* de cet espace de réglages :

- **par axe** : `libre` / `= un attribut` / `= le temps` ;
- **source d'attraction** : `arêtes` / `similarité d'attributs` / `les deux` ;
- **regroupement par communauté** : `on` / `off`.

Le mode temporel actuel ([render.js `temporalLayout`](../frontend/render.js)) est déjà la
preuve vivante du modèle : `X = année (C)`, `Y = force préservée (A)`. On généralise.

### Ce que chaque stratégie apporte (boussole)

| | Apport | Nature |
|---|---|---|
| **A** — force enrichie | **mieux lire** une structure déjà connue (groupes nets, hubs dégagés) | émergent |
| **B** — proximité calculée | **connaissance nouvelle** : « qui se *ressemble* » au-delà de « qui a *collaboré* » | calculé |
| **C** — axes porteurs de sens | **argument explicite** : position = affirmation testable et annotable (export Word) | assigné |

## Garde-fous (tout ticket les respecte)

1. **Invariant stabilité ↔ export.** Les positions restent *calculées une fois, déterministes
   (`seed` fixe), partagées* entre projections / crans temporels / export. Aucun ticket
   n'introduit de layout *live* (cf. hors-scope).
2. **Vue par défaut inchangée.** La démo reste à **53 nœuds / 70 liens**, disposition force,
   tant qu'aucun nouveau réglage n'est activé.
3. **Réglable, pas figé.** Tout nouveau comportement est exposé en contrôle UI + paramètre API ;
   aucune heuristique cachée non débrayable.
4. **Tests.** Backend couvert par `pytest` ; le rendu Sigma est validé *visuellement* (non
   automatisable ici) → chaque ticket front liste ses vérifications manuelles.

## Hors-scope (différé — les « transversaux »)

- Layout **live** en *web worker* (superviseur ForceAtlas2 continu).
- **Épinglage multi-nœuds** / contraintes d'ancrage.

> Raison : ils renégocient l'invariant stabilité ↔ export (cf. discussion). À reconsidérer
> seulement si la taille des fichiers rend le layout synchrone bloquant.

---

## État des lieux — l'acquis réutilisable

Une bonne part des fondations existe déjà. Cette table dit *ce qu'on a* et *qui le réutilise* ;
les tickets ci-dessous détaillent *ce qu'il faut construire* par-dessus.

| Fondation existante | Où | Réutilisée par |
|---|---|---|
| Pipeline ForceAtlas2 + objet `settings` (gravity, scalingRatio, barnesHut, adjustSizes) | [render.js:187-193](../frontend/render.js#L187-L193) | T3, T4 |
| Communautés Louvain **déterministes** (`random_state=42`) + `node.community` envoyé au front | [analysis.py:112-133](../backend/analysis.py#L112-L133), [main.py:200](../backend/main.py#L200) | T3 (semis + couleur) |
| `node_mean_year` agrège `work_years` déposé par `project()` *(le patron à généraliser)* | [graph.py:91-101](../backend/graph.py#L91-L101), [:456](../backend/graph.py#L456) | T1 |
| `mean_year` + `work_count` par nœud déjà dans `/graph` | [main.py:193,201](../backend/main.py#L193) | T1, T2 |
| Mode temporel : `X = année`, `Y = force préservé` + rendu d'axe temps (`updateTimeAxis`) | [render.js:203-228](../frontend/render.js#L203-L228) | T2 |
| Attributs / co-entités par nœud (fiche, cartes, `entities_by_type`) | [graph.py `node_detail`](../backend/graph.py) | T1, T4, T5 |
| Poids d'arête (= ouvrages partagés) émis dans `/graph` | [main.py:205](../backend/main.py#L205) | T4 |
| Dispatch `layout(kind, opts)` + `layoutSignature()` + 4 presets | [render.js:177](../frontend/render.js#L177), [app.js:636](../frontend/app.js#L636) | T0 |
| Positions **déterministes, calculées une fois** (`seed=42`) → cohérence export | [graph.py:667-680](../backend/graph.py#L667-L680) | invariant, tous |
| Palette catégorielle de communautés | [analysis.py:24-28](../backend/analysis.py#L24-L28) | T3 (couleur) |
| `numpy` disponible (dépendance transitive de `pandas`) → MDS sans nouvelle dép. | `requirements.txt` | T5 |

**Lecture** : T3 (force enrichie) et T2 (axes) sont en grande partie de l'**assemblage d'acquis** ;
T1 est une **généralisation** d'un patron existant ; seuls T4 et T5 introduisent de la mécanique
vraiment neuve (similarité, MDS).

---

## Vue d'ensemble des tickets

| # | Titre | Dépend de | Effort | Risque |
|---|---|---|---|---|
| **T0** | Socle : seam du moteur de placement | — | M | M (colonne vertébrale) |
| **T1** | Brique partagée : agrégat d'attribut par nœud (backend) | — | S | Faible |
| **T2** | C — Axes porteurs de sens | T0, T1 | M | Moyen |
| **T3** | A — Force enrichie | T0 | S→M | Faible |
| **T4** | B-force — Similarité comme attraction | T1, T3 | M | Moyen |
| **T5** | B-pur — Placement par réduction de dimension (MDS) | T1 | L | Élevé |

**Jalons** : *Socle* (T0+T1) → *Lisibilité* (T2+T3) → *Similarité* (T4) → *Exploration avancée* (T5).
Chaque jalon est livrable et utile seul.

---

## T0 — Socle : seam du moteur de placement

**But.** Préparer [render.js](../frontend/render.js) à recevoir des stratégies paramétrées,
sans changer aucun comportement utilisateur. Évite que T2 introduise en douce un gros refactor.

**Acquis.** Dispatch `layout(kind, opts)` ([render.js:177](../frontend/render.js#L177)),
`layoutSignature()` ([app.js:636](../frontend/app.js#L636)), 4 presets fonctionnels.

**Scope.**
- Extraire la sélection de disposition en un placeur qui lit un objet de réglages
  `{ xAxis, yAxis, attraction, grouping }`.
- Réexprimer `force`, `temporal`, `circular`, `random` comme **presets** de cet objet.
- Étendre `layoutSignature()` ([app.js](../frontend/app.js)) pour inclure les nouveaux champs
  (afin que le relayout se déclenche au bon moment).

**Hors-scope.** Aucun nouveau preset visible ; aucune nouvelle entrée dans le sélecteur.

**Touchpoints.** `render.js` (`layout`, `temporalLayout`), `app.js` (`layoutSignature`, `State.layout`).

**Critères d'acceptation.**
- Force / temporel / circulaire / dispersée **strictement identiques** à aujourd'hui (vérif visuelle).
- Vue par défaut toujours 53/70.
- Le déclenchement du relayout (signature) est inchangé pour les presets existants.

**Note.** Peut être *fusionné dans T2* si on préfère faire émerger le seam plutôt que le poser
d'avance. Le garder séparé rend T2 plus petit et moins risqué.

---

## T1 — Brique partagée : agrégat d'attribut par nœud (backend)

**But.** Généraliser le mécanisme existant `work_years → node_mean_year`
([graph.py:91-101](../backend/graph.py#L91-L101), déposé en [graph.py:456](../backend/graph.py#L456))
de « années » vers **n'importe quel attribut**. Brique invisible qui débloque **T2 et T4/T5**.

**Acquis.** Le patron exact à généraliser : `work_years` déposé en [graph.py:456](../backend/graph.py#L456),
agrégé par [`node_mean_year`](../backend/graph.py#L91-L101) ; attributs / co-entités par nœud déjà
disponibles ([`node_detail`](../backend/graph.py)) ; `mean_year` + `work_count` déjà émis dans `/graph`.

**Scope.**
- Pendant `project()`, déposer par nœud-entité la **distribution de ses attributs** sur ses
  ouvrages actifs (ex. `{ "Genre": {"Roman": 4, "Jeunesse": 1}, "Langue cible": {...} }`),
  comme `work_years` l'est déjà pour le temps.
- Fonction d'agrégation par nœud : `aggregate(attr, mode)` avec `mode ∈ {dominante, moyenne, première}`
  (numérique → moyenne ; catégoriel → dominante). Robuste à la fusion `hinge_key`.
- Exposer ces agrégats dans la sortie `/graph` (ou un `/axes` dédié) pour le front.

**Hors-scope.** Aucune UI ; aucun changement de disposition. Pur backend + données.

**Touchpoints.** `graph.py` (`project`, nouveau helper à côté de `node_mean_year`), `main.py` (`build_view`).

**Critères d'acceptation.**
- Test pytest : sur la démo, l'agrégat « Genre / dominante » d'un auteur connu == sa valeur attendue.
- Multi-valué géré (un auteur à cheval sur 2 genres → distribution correcte, dominante déterministe).
- `mean_year` reste un cas particulier cohérent de la nouvelle brique.
- Vue par défaut inchangée (la brique est inerte tant qu'on ne s'en sert pas).

---

## T2 — C : Axes porteurs de sens

> **État : livré.** Disposition « Axes » + sélecteurs X/Y + ordre (alpha/fréquence), placeur
> `axesLayout` (numérique → position, catégoriel → colonnes + jitter, libre → force), consomme
> `/axes`, dégradation gracieuse si données absentes, **graduations X (bas) et Y (gauche)** avec
> libellés (numérique → ticks ronds ; catégoriel → noms de colonnes). **Reste (mineur)** : ordre
> « par année moyenne » et « manuel » (seuls alpha/fréquence) ; décimation des libellés quand
> les catégories sont trop nombreuses (sinon chevauchement).

**But.** Donner une **signification** aux coordonnées : `X` et/ou `Y` = un attribut au choix
(ou le temps, ou la force). Généralise `temporalLayout` ([render.js:203-228](../frontend/render.js#L203-L228)).

**Acquis.** `temporalLayout` fait déjà `X = temps, Y = force préservé` + le rendu d'axe
(`updateTimeAxis`) → ~70 % de la plomberie ; `mean_year` / `work_count` par nœud (via T1) prêts.

**Scope.**
- Réglages : `axe X ∈ {libre, temps, attribut}` ; `axe Y ∈ {force, attribut, centralité}`.
- Pour un axe = attribut : valeur du nœud via la **brique T1**. Catégoriel → **ordre des
  catégories** réglable (`alphabétique / fréquence / année moyenne / manuel`).
- Anti-collision léger sur un axe libre résiduel (réutiliser la logique Y du temporel).
- UI : deux sélecteurs d'axe + sélecteur d'ordre, dans les Options avancées ([index.html](../frontend/index.html)).

**Hors-scope.** Pas de similarité (T4) ; pas de MDS (T5).

**Touchpoints.** `render.js` (placeur via T0), `app.js` (réglages + signature), `index.html`, `styles.css`.

**Critères d'acceptation.**
- Preset « X = temps » reproduit exactement le temporel actuel (régression).
- « X = Genre, Y = année » produit un nuage lisible ; cliquer un nœud ouvre sa fiche (positions valides).
- Export PNG/SVG correspond à l'écran (axes inclus si possible).
- Vérif visuelle : agrégation d'une entité multi-valuée placée selon la règle annoncée.

---

## T3 — A : Force enrichie

> **État : livré.** Bloc « Réglages de force » (Options avancées) : `linLogMode` (resserrer les
> groupes), `outboundAttractionDistribution` (écarter les hubs), `edgeWeightInfluence` (curseur
> influence des liens), et **semis par communauté** Louvain (déterministe). Mutualisé via
> `runForce()`/`fa2Settings()` (force + base des modes axes/temporel). Défaut inchangé (galaxie
> identique). Bloc masqué hors dispositions à base de force ; curseur d'influence appliqué au
> relâcher (pas de relayout par cran). **Reste (mineur)** : rafraîchir la base force en mode
> axes/temporel sans repasser par la disposition force.

**But.** Mieux *lire* la structure existante via les leviers de ForceAtlas2 + un regroupement
par communauté. Reste émergent et déterministe.

**Acquis.** Objet `settings` FA2 ([render.js:188-193](../frontend/render.js#L188-L193)) ; `node.community`
**déterministe** déjà calculé et envoyé au front ([analysis.py:112-133](../backend/analysis.py#L112-L133),
[main.py:200](../backend/main.py#L200)) ; palette de communautés ([analysis.py:24-28](../backend/analysis.py#L24-L28)).

**Scope.**
- Exposer dans `settings` ([render.js:188-193](../frontend/render.js#L188-L193)) :
  `edgeWeightInfluence` (curseur « influence des ouvrages partagés »), `linLogMode`
  (bascule « resserrer les groupes »), `outboundAttractionDistribution` (bascule « écarter les hubs »).
- **Regroupement par communauté** : semer les positions initiales par cluster Louvain
  (déjà calculé, [analysis.py](../backend/analysis.py), déjà passé au front pour la couleur) —
  centroïdes écartés *avant* FA2, `seed` conservé.

**Hors-scope.** Force custom dans FA2 (non supporté proprement) ; toute approche live.

**Touchpoints.** `render.js` (`settings`, semis initial), `app.js` (réglages + signature), `index.html`.

**Critères d'acceptation.**
- Réglages par défaut → disposition force **inchangée** (53/70, même allure).
- LinJog activé : communautés visiblement plus resserrées (vérif visuelle).
- Semis-communauté : amas spatiaux ≈ couleurs Louvain ; reste **déterministe** (même rendu à 2 lancers).

---

## T4 — B-force : Similarité comme attraction

> **État : livré.** `graph.similarity_edges` (cosinus sur les profils d'attributs **catégoriels**,
> par type, seuil + cap top-k) et endpoint `/similar`. Toggle « Rapprocher les nœuds semblables »
> avec cases des attributs pris en compte (débrayables). Les arêtes latentes sont injectées
> **invisiblement** dans ForceAtlas2 le temps du calcul puis retirées (jamais affichées ni
> comptées ni exportées). **Reste** : similarité **numérique** (distance) ; mode « similarité
> pure » (ignorer la structure) ; curseur de seuil exposé (fixé à 0,5 pour l'instant).

**But.** Le saut analytique, version compatible avec l'invariant : rapprocher les nœuds
*similaires* (attributs) sans jeter la force ni les arêtes structurantes.

**Acquis.** Brique T1 (distributions d'attributs par nœud) ; poids d'arête déjà géré
([main.py:205](../backend/main.py#L205)) ; moteur ForceAtlas2 de T3 dans lequel injecter les arêtes latentes.

**Scope.**
- À partir des distributions d'attributs (**brique T1**), calculer une **similarité** (cosinus)
  entre nœuds d'un même type.
- Émettre des **arêtes invisibles pondérées** entre paires très similaires (seuil réglable),
  fournies à ForceAtlas2 → fusionne avec T3.
- Réglage `attraction ∈ {arêtes, similarité, les deux}` + cases « attributs pris en compte » + poids.

**Hors-scope.** Réduction de dimension (T5).

**Touchpoints.** `graph.py` ou `analysis.py` (similarité), `main.py` (`/graph` : arêtes latentes),
`render.js` (intégration au placeur), `app.js`, `index.html`.

**Critères d'acceptation.**
- Test pytest : deux nœuds sans ouvrage commun mais attributs proches obtiennent une arête latente ≥ seuil.
- Mode « arêtes » seul → identique à T3 (pas de régression).
- Vérif visuelle : en mode « les deux », des entités sans lien direct mais similaires se rapprochent.
- Les attributs pris en compte sont **débrayables** (pas de boîte noire).

---

## T5 — B-pur : Placement par réduction de dimension (MDS)

**But.** Une vraie « carte de similarité » : distance à l'écran ≈ dissimilarité d'attributs.
Le plus riche, le plus risqué.

**Acquis.** Brique T1 (vecteurs d'attributs) ; `numpy` déjà présent (dépendance de `pandas`) →
MDS classique **sans nouvelle dépendance** ; invariant export réutilisé tel quel.

**Scope.**
- Vecteur par nœud (one-hot catégoriels + numériques normalisés, via **brique T1**).
- Matrice de distances → **MDS classique en numpy** (décomposition propre, **pas de nouvelle
  dépendance** ; UMAP/t-SNE explicitement *exclus* en première intention).
- Preset de disposition « par similarité » ; déterministe (réutilise l'invariant export).
- UI de pondération des attributs (réutilise celle de T4).

**Hors-scope.** UMAP / t-SNE (dépendance lourde) — à rouvrir seulement si MDS insuffisant.

**Touchpoints.** `analysis.py` (MDS numpy), `main.py` (positions alternatives), `render.js`, `app.js`.

**Critères d'acceptation.**
- MDS déterministe (même entrée → mêmes coordonnées).
- Export cohérent avec l'écran.
- Avertissement UI : en MDS-pur, les arêtes structurantes ne contraignent plus la position
  (différence de lecture assumée) ; bascule facile vers T4 (mixte).
- Vérif visuelle : groupes d'attributs proches forment des amas.

---

## Risques transverses & décisions ouvertes

- **Agrégation des entités multi-valuées** (T1) : la règle `dominante/moyenne/première` *fabrique*
  une partie du résultat de T2/T4/T5 → toujours l'exposer et la documenter, jamais la cacher.
- **Ordre des axes catégoriels** (T2) : un choix d'ordre oriente la lecture → réglable + visible.
- **Pondération des attributs** (T4/T5) : sans contrôle utilisateur, c'est une boîte noire →
  cases à cocher + poids obligatoires dès T4.
- **Refactor du seam** (T0) : seul ticket qui touche la colonne vertébrale du rendu → le faire
  petit, le couvrir par régression visuelle des 4 presets existants.
