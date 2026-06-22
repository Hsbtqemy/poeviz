# Notes de design (frontend)

Référence visuelle pour le prototype. Les captures `shot_interface.png`, `shot_roles.png`, `shot_modes.png` dans ce dossier montrent l'agencement cible.

## Palette
- Fond : crème clair `#F7F4EE`
- Panneaux : `#FBF9F4` / `#F4F1EA`
- Encre (texte) : `#23201C`
- Lignes / bordures : `#E0DBD0`
- Accent vert (nœud / actif) : `#1D8A68`
- Accent ambre : `#C07A1A`
- Rouge sélection : `#B8453F`
- Bleu (info / attribut) : `#3B6FA8`
- Violet (auteurs, ex.) : `#7B5BD6`
- Gris discret : `#8A857B`

## Typo
- Titres / labels d'UI : sans-serif (system-ui, Arial).
- Possible serif (Georgia) pour les grands titres de panneau si souhaité. Garder lisible avant tout.

## Couleur des nœuds par type (proposition, à adapter aux colonnes réelles)
- Auteurs → violet `#7B5BD6`
- Traducteurs → vert `#1D8A68`
- Éditeurs → rouge/corail `#B8453F`
- Langues → bleu `#3B6FA8`
- Genres / Lieux → ambre `#C07A1A`
Quand « couleur par communauté » est activée, ignorer le type et colorer par cluster Louvain.

## Agencement
- 3 zones : barre latérale gauche (~265px) · canvas central (flex) · panneau détail droit (~310px, masqué par défaut, apparaît à la sélection).
- Barre du haut du canvas : curseur temporel à gauche, boutons Exporter/Partager à droite.
- Ligne d'aide discrète en bas du canvas.

## Ton des libellés (FR, sans jargon)
- « Organiser autour de » (pas « pivot »)
- « Couches visibles »
- « Options avancées » (repliée)
- « Quand une couche est masquée, ses liens… se reportent / se coupent »
- « Effet du pivot : réorganise / filtre seul »
- « Affichage : automatique / toujours points / toujours cartes »

## États vides / erreurs
Messages utiles dans la voix de l'interface, pas d'excuses : expliquer quoi faire (« Déposez un fichier .xlsx pour commencer », « Cette colonne n'a que des valeurs uniques — elle convient mieux comme lien que comme nœud »).
