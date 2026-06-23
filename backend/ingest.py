"""
ingest.py — Lecture d'un classeur Excel, profilage des colonnes et découpe
des cellules multi-valeurs.

Rien ici n'est spécifique à un fichier : on lit n'importe quel .xlsx de
structure raisonnable (une ligne d'en-têtes, puis des lignes de données),
on mesure chaque colonne, et on *suggère* un rôle que l'utilisateur pourra
toujours changer côté interface.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, asdict, field
from typing import Any

import pandas as pd

# --------------------------------------------------------------------------
# Constantes réglables (cf. CLAUDE.md §3.4 et §3.3)
# --------------------------------------------------------------------------

# Séparateurs reconnus à l'intérieur d'une même cellule pour les colonnes-nœud.
# Éditables ici ; surchargés au besoin par l'appel /configure.
# Note : l'ordre compte un peu (on découpe sur tous, successivement). La virgule
# est incluse car demandée par le brief — l'utilisateur peut la retirer si ses
# données contiennent des noms « Nom, Prénom ».
DEFAULT_SEPARATORS: list[str] = [";", " & ", " et ", " and ", "&", ","]

# Au-delà de ce taux d'unicité, une colonne est plutôt un *lien* (ex. un titre
# d'ouvrage, quasi unique) qu'un *nœud*.
EDGE_UNIQUENESS_THRESHOLD = 0.9

# En deçà de ce taux d'unicité (valeurs distinctes / valeurs totales), une colonne
# texte est « catégorielle courte » (Genre, Lieu, Réédition, Langue) → suggérée
# comme *info* plutôt que comme type d'entité. Réglage relatif (pas absolu), pour
# rester robuste quel que soit le nombre de lignes.
ATTRIBUTE_UNIQUENESS_THRESHOLD = 0.2

# Une colonne avec au plus ce nombre de valeurs distinctes (binaire « oui/non »,
# constante…) est toujours une *info*, jamais un type d'entité.
MAX_UNIQUE_FOR_ATTRIBUTE = 2

# Plage plausible d'une année (utilisée pour repérer une colonne temporelle).
YEAR_MIN, YEAR_MAX = 1000, 2300

ROLE_NODE = "node"
ROLE_EDGE = "edge"
ROLE_ATTRIBUTE = "attribute"
ROLE_IGNORE = "ignore"

# Nom par défaut de la charnière (l'unité qui relie les entités = une ligne).
# Neutre, indépendant du fichier ; l'utilisateur peut le redéfinir.
DEFAULT_UNIT = ("objet", "objets")

# Noms de feuille trop génériques pour servir de nom d'unité → on retombe sur
# « objet ». (Le nom de feuille n'est suggéré que s'il est parlant.)
GENERIC_SHEET_NAMES = {
    "feuille", "feuil", "sheet", "data", "données", "donnees", "tableau",
    "table", "classeur", "export", "page", "import", "base",
}


def pluralize_fr(word: str) -> str:
    """Pluriel français approximatif — suffit pour un nom d'unité court."""
    w = word.strip()
    if not w:
        return w
    low = w.lower()
    if low[-1] in ("s", "x", "z"):
        return w
    if low.endswith(("eau", "au", "eu")):
        return w + "x"   # tableau→tableaux, niveau→niveaux, jeu→jeux
    return w + "s"


# Noms français déjà invariants au pluriel : ils se terminent par « s » au singulier
# (« un avis / des avis »). On ne leur retire donc pas le « s » final. Les terminaisons
# en -x/-z sont déjà préservées par `singularize_fr` (il ne coupe qu'un « s »).
INVARIANT_NOUNS = {
    "avis", "repas", "cas", "pays", "corps", "temps", "mois", "bois", "bras",
    "tas", "fois", "dos", "héros", "univers", "concours", "discours", "secours",
    "succès", "progrès", "puits", "jus", "sens", "fils", "fonds", "pas", "colis",
    "parcours", "palais", "relais", "vers", "tapis", "anchois", "velours",
}


def singularize_fr(word: str) -> str:
    """Singulier français approximatif (retire un « s » final).

    Épargne les noms déjà invariants au pluriel (avis, repas, prix…) et les
    terminaisons en « -us » (bus, virus, corpus) qui sont souvent des singuliers."""
    w = word.strip()
    low = w.lower()
    if low in INVARIANT_NOUNS:
        return w
    if len(w) > 3 and low.endswith("s") and not low.endswith("us"):
        return w[:-1]
    return w


def default_unit_label(sheet_name: str | None) -> tuple[str, str]:
    """Suggère (singulier, pluriel) pour le nom d'une ligne.

    Dérivé du nom de feuille quand il est parlant (« Traductions » →
    « traduction / traductions »), sinon « objet / objets ». On renvoie en
    minuscules ; l'interface capitalise au besoin.
    """
    name = (sheet_name or "").strip()
    low = name.lower()
    if (not name or low in GENERIC_SHEET_NAMES
            or re.fullmatch(r"(feuil|feuille|sheet|table|page|classeur)\s*\d*", low)):
        return DEFAULT_UNIT
    singular = singularize_fr(low)
    plural = low if singular != low else pluralize_fr(low)
    return (singular, plural)


@dataclass
class ColumnProfile:
    """Description d'une colonne, telle que renvoyée à l'interface."""
    name: str
    dtype: str                 # "text" | "number" | "date"
    n_unique: int
    n_filled: int
    n_rows: int
    uniqueness: float          # n_unique / n_filled (0 si colonne vide)
    samples: list[str]
    suggested_role: str
    is_year_candidate: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Dataset:
    """Un classeur lu en mémoire : une feuille active + ses données brutes."""
    sheets: list[str]
    active_sheet: str
    frames: dict[str, pd.DataFrame] = field(default_factory=dict)

    @property
    def df(self) -> pd.DataFrame:
        return self.frames[self.active_sheet]


# --------------------------------------------------------------------------
# Lecture du classeur
# --------------------------------------------------------------------------

def read_workbook(content: bytes) -> Dataset:
    """Lit toutes les feuilles d'un .xlsx (octets) en DataFrames.

    Les cellules sont gardées telles quelles (texte) autant que possible pour
    préserver les valeurs d'origine ; le profilage déduit ensuite les types.
    """
    buffer = io.BytesIO(content)
    # sheet_name=None → dict {feuille: DataFrame}. dtype=object pour ne pas
    # laisser pandas transformer « 2019 » en float silencieusement partout.
    raw = pd.read_excel(buffer, sheet_name=None, engine="openpyxl", dtype=object)
    if not raw:
        raise ValueError("Le classeur ne contient aucune feuille.")

    frames: dict[str, pd.DataFrame] = {}
    for name, frame in raw.items():
        # Nettoie les colonnes « Unnamed: N » (en-têtes vides) et lignes vides.
        frame = frame.dropna(axis=0, how="all")
        frame.columns = [_clean_header(c, i) for i, c in enumerate(frame.columns)]
        frames[name] = frame.reset_index(drop=True)

    sheets = list(frames.keys())
    return Dataset(sheets=sheets, active_sheet=sheets[0], frames=frames)


def _clean_header(col: Any, index: int) -> str:
    text = "" if col is None else str(col).strip()
    if not text or text.lower().startswith("unnamed"):
        return f"Colonne {index + 1}"
    return text


# --------------------------------------------------------------------------
# Profilage des colonnes
# --------------------------------------------------------------------------

def profile_dataframe(df: pd.DataFrame,
                      separators: list[str] | None = None) -> list[ColumnProfile]:
    """Profile chaque colonne et propose un rôle. Tient compte du fait qu'une
    cellule peut contenir plusieurs valeurs (séparateurs)."""
    separators = separators or DEFAULT_SEPARATORS
    n_rows = len(df)
    profiles: list[ColumnProfile] = []

    for col in df.columns:
        series = df[col]
        # Valeurs « atomiques » après découpe multi-valeurs (pour le compte d'unicité).
        atomic: list[str] = []
        filled = 0
        for raw_value in series:
            parts = split_cell(raw_value, separators)
            if parts:
                filled += 1
                atomic.extend(parts)

        unique_values = sorted(set(atomic), key=str.lower)
        n_unique = len(unique_values)
        # Taux d'unicité rapporté aux valeurs *atomiques* → toujours dans [0, 1],
        # même quand une cellule contient plusieurs entités.
        uniqueness = (n_unique / len(atomic)) if atomic else 0.0
        dtype = _infer_dtype(series)
        year_candidate = _looks_like_year_column(col, series, dtype)

        profiles.append(ColumnProfile(
            name=str(col),
            dtype=dtype,
            n_unique=n_unique,
            n_filled=filled,
            n_rows=n_rows,
            uniqueness=round(uniqueness, 3),
            samples=unique_values[:5],
            suggested_role=suggest_role(dtype, n_unique, uniqueness, year_candidate),
            is_year_candidate=year_candidate,
        ))

    _ensure_node_candidate(profiles)
    return profiles


def _ensure_node_candidate(profiles: list[ColumnProfile]) -> None:
    """Garantit au moins une colonne en rôle « nœud » quand c'est possible :
    sinon la carte serait vide. On promeut la colonne texte la plus « nœud-like »
    (taux d'unicité modéré, plusieurs valeurs répétées)."""
    if any(p.suggested_role == ROLE_NODE for p in profiles):
        return
    candidates = [
        p for p in profiles
        if p.dtype == "text" and not p.is_year_candidate
        and p.n_unique > MAX_UNIQUE_FOR_ATTRIBUTE
        and p.uniqueness < EDGE_UNIQUENESS_THRESHOLD
    ]
    if not candidates:
        return
    # La meilleure : taux d'unicité le plus élevé sous le seuil de lien
    # (beaucoup d'entités distinctes mais réutilisées).
    best = max(candidates, key=lambda p: p.uniqueness)
    best.suggested_role = ROLE_NODE


def suggest_role(dtype: str, n_unique: int, uniqueness: float,
                 year_candidate: bool) -> str:
    """Heuristique de suggestion de rôle (cf. CLAUDE.md §3.3).

    L'utilisateur reste libre de tout changer ; ceci ne fait que pré-remplir.
    """
    if n_unique == 0:
        return ROLE_IGNORE
    # Numérique (année, prix, compteur) ou date → enrichit la fiche.
    if dtype in ("number", "date") or year_candidate:
        return ROLE_ATTRIBUTE
    # Une colonne quasi-unique (un titre) relie mieux qu'elle n'affiche.
    if uniqueness >= EDGE_UNIQUENESS_THRESHOLD and n_unique > MAX_UNIQUE_FOR_ATTRIBUTE:
        return ROLE_EDGE
    # Binaire / quasi-constant (oui/non, une seule langue) → info.
    if n_unique <= MAX_UNIQUE_FOR_ATTRIBUTE:
        return ROLE_ATTRIBUTE
    # Catégoriel court relativement aux lignes (Genre, Lieu) → info.
    if uniqueness < ATTRIBUTE_UNIQUENESS_THRESHOLD:
        return ROLE_ATTRIBUTE
    # Texte répété, ni trop unique ni trop court → type d'entité affiché.
    return ROLE_NODE


def _infer_dtype(series: pd.Series) -> str:
    """Devine "number" / "date" / "text" à partir des valeurs non vides."""
    values = [v for v in series if not _is_blank(v)]
    if not values:
        return "text"
    n_num = sum(1 for v in values if _is_number(v))
    if n_num / len(values) >= 0.8:
        return "number"
    n_date = sum(1 for v in values if _is_date(v))
    if n_date / len(values) >= 0.8:
        return "date"
    return "text"


def _looks_like_year_column(col: Any, series: pd.Series, dtype: str) -> bool:
    """True si la colonne ressemble à une suite d'années (pour le curseur temporel)."""
    name = str(col).lower()
    name_hint = any(k in name for k in ("année", "annee", "year", "date", "an"))
    numeric_years = []
    for v in series:
        y = parse_year(v)
        if y is not None:
            numeric_years.append(y)
    if not numeric_years:
        return False
    ratio = len(numeric_years) / max(1, sum(1 for v in series if not _is_blank(v)))
    return ratio >= 0.6 and (name_hint or dtype in ("number", "date"))


# --------------------------------------------------------------------------
# Découpe des cellules multi-valeurs
# --------------------------------------------------------------------------

def split_cell(value: Any, separators: list[str] | None = None) -> list[str]:
    """Découpe une cellule en valeurs atomiques, nettoyées et dédoublonnées
    (en gardant l'ordre). Une cellule vide renvoie []."""
    separators = separators or DEFAULT_SEPARATORS
    if _is_blank(value):
        return []
    text = _normalize_scalar(value)
    # Construit une regex alternant tous les séparateurs (échappés).
    pattern = "|".join(re.escape(s) for s in separators if s)
    parts = re.split(pattern, text) if pattern else [text]
    seen: list[str] = []
    for p in parts:
        cleaned = p.strip().strip("·•-").strip()
        if cleaned and cleaned not in seen:
            seen.append(cleaned)
    return seen


def _normalize_scalar(value: Any) -> str:
    """Représentation texte propre d'une valeur de cellule (évite « 2019.0 »)."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _is_blank(value: Any) -> bool:
    if value is None:
        return True
    try:
        if pd.isna(value):
            return True
    except (TypeError, ValueError):
        pass
    return str(value).strip() == ""


def _is_number(value: Any) -> bool:
    if isinstance(value, (int, float)):
        return True
    try:
        float(str(value).replace(",", ".").strip())
        return True
    except (TypeError, ValueError):
        return False


def _is_date(value: Any) -> bool:
    if hasattr(value, "year") and hasattr(value, "month"):
        return True
    text = str(value).strip()
    return bool(re.match(r"^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$", text))


def parse_year(value: Any) -> int | None:
    """Extrait une année plausible d'une valeur (nombre, date, ou texte « 2019 »)."""
    if _is_blank(value):
        return None
    if hasattr(value, "year"):
        try:
            return int(value.year)
        except (TypeError, ValueError):
            return None
    text = _normalize_scalar(value)
    match = re.search(r"\b(\d{3,4})\b", text)
    if not match:
        return None
    year = int(match.group(1))
    return year if YEAR_MIN <= year <= YEAR_MAX else None
