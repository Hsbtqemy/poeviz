# Spec — Mode focalisation (ego)

> Explorer **le monde d'un nœud précis** : cliquer un nœud le pose comme centre,
> restreint la vue à son **ego-réseau** (lui + voisinage à N sauts), le garde centré,
> et laisse **tous les réglages d'organisation** (disposition, force, similarité,
> couches, temps) opérer **dans ce périmètre**. On marche de proche en proche, on
> revient en arrière, on ressort vers le graphe complet.

## Pourquoi (vs l'existant)

- Le **clic** actuel ne fait qu'estomper le voisinage (cosmétique, perdu au relayout).
- Le **pivot** agit au niveau d'un *type* (colonne).
- Ici c'est du **niveau nœud** : on isole *vraiment* un sous-graphe → force/MDS/métriques
  se recalculent dessus (cartes locales nettes, **centralités locales**), et la
  focalisation **persiste** quand on change les réglages.

Bâtit sur de l'existant : `neighborhood(node, hops)` (déjà utilisé par l'export
« voisinage à N sauts »), `setFocus`, `centerOnNodes`, et la projection de `/graph`.

## Décisions (validées)

- **Isolation : vrai sous-graphe** — on projette réellement sur l'ego ; métriques,
  force et MDS se recalculent sur ce seul sous-graphe.
- **Entrée : bouton + double-clic** — bouton « Focaliser » dans la fiche, *et*
  double-clic sur un nœud.
- **Profondeur : réglable 1–3 sauts** (curseur).
- **Navigation : clic d'un voisin → re-focalise** dessus (fil d'Ariane), **+ bouton
  Retour** pour revenir au focus précédent.

## Backend

- `/graph` gagne deux paramètres : `focus` (id de nœud) et `hops` (entier, défaut 1,
  plafonné à 3).
- Après la **projection** P habituelle (respecte couches / connecteurs / fenêtre
  temporelle), si `focus ∈ P` : calculer l'**ego** par parcours en largeur depuis
  `focus` jusqu'à `hops` sauts dans P, puis `P ← P.subgraph(ego)`.
  **Les métriques (centralité, communautés, densité) sont alors recalculées sur
  l'ego** → valeurs *locales*.
- `focus ∉ P` (filtré par le temps / les couches) → ignorer le focus, renvoyer la vue
  complète, et le signaler (champ `focus_dropped: true`) pour que le front sorte
  proprement du mode.
- Aucun changement au graphe maître ni aux positions partagées (l'ego réutilise les
  positions globales comme amorce ; le front relayoute le sous-graphe).

## Frontend

- État : `focus` (id|null), `focusHops` (1..3), `focusTrail` (pile pour le Retour).
- **Entrée** : bouton « Focaliser sur ce nœud » dans la fiche (entité *ou* charnière)
  + événement `doubleClickNode` de Sigma.
- **Barre de focalisation** (haut du canvas, visible en mode focus) :
  `Focalisé : <label> · profondeur [1–3] · ‹ Retour · ✕ Vue complète` + fil d'Ariane.
- **Navigation** : en focus, cliquer un nœud → re-focalise dessus (empile le précédent
  dans `focusTrail`) ; **Retour** dépile ; **✕ / clic sur le fond** quitte le mode
  (vide la pile, retour au graphe complet).
- `queryString` ajoute `focus` + `hops` quand le mode est actif ; `layoutSignature`
  les inclut (→ relayout au changement de focus/profondeur). Tous les autres réglages
  (force, MDS, axes, couches, curseur temporel) s'appliquent tels quels au sous-graphe
  renvoyé — **rien d'autre à modifier dans leur logique**.
- L'export « périmètre = vue courante » exporte naturellement le sous-graphe focalisé.

## Critères d'acceptation

- Focaliser un auteur → ne restent que lui + ses voisins (N sauts) ; les centralités
  du volet sont **locales** ; il **reste centré** quand on change de disposition.
- Passer la profondeur 1 → 2 élargit le périmètre ; 2 → 1 le resserre.
- Re-focaliser sur un voisin puis **Retour** revient au focus précédent ; **✕** rend
  le graphe complet.
- Focaliser puis basculer en **MDS** / **axes** / **force enrichie** : la disposition
  s'applique au seul ego.
- **Hors focus : comportement strictement inchangé** (invariant — `focus` absent =
  vue actuelle).

## Étapes de construction

1. **Backend** : ego dans `build_view` (sous-graphe + métriques locales) + params
   `focus`/`hops` sur `/graph` ; `focus_dropped`. Tests (ego = bon ensemble ;
   métriques locales ; focus hors-vue ignoré ; vue par défaut inchangée).
2. **Frontend** : état + `queryString` + `layoutSignature` + barre de focalisation
   (bouton, double-clic, curseur profondeur, Retour, fil d'Ariane, ✕) + boucle de
   re-focalisation. Vérif visuelle.

## Bords / notes

- Focaliser un **nœud-charnière** (ouvrage) marche aussi (son ego = ses entités).
- Compose avec le **pivot** (type) et le **curseur temporel** sans cas particulier.
- Perf : ego borné (1–3 sauts) → léger, même sur gros fichiers.
- Reste possible plus tard : « épingler » plusieurs centres ; surligner le chemin
  entre deux nœuds focalisés.
