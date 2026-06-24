#!/usr/bin/env bash
#
# Redéploiement depuis git — à lancer SUR le VPS, dans /srv/poeviz :
#     ./deploy/update.sh
#
# Récupère origin/main, réinstalle les dépendances, redémarre le service, vérifie la
# santé. Idempotent. `.env` et `.venv/` (ignorés par git) ne sont jamais touchés.
set -euo pipefail

# Racine du projet (le dossier parent de deploy/), quel que soit le cwd d'appel.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# sudo seulement si on n'est pas déjà root (le restart du service en a besoin).
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# Port d'écoute (depuis .env si présent, sinon 8000) pour le test de santé.
PORT_VAL="$( [ -f .env ] && grep -E '^PORT=' .env | tail -1 | cut -d= -f2 || true )"
PORT_VAL="${PORT_VAL:-8000}"

echo "▸ Récupération de origin/main"
git fetch --quiet origin
git reset --hard origin/main         # le serveur reflète exactement git (pas d'édition locale)

echo "▸ Dépendances Python"
.venv/bin/pip install -q -r requirements.txt

echo "▸ Redémarrage du service poeviz"
$SUDO systemctl restart poeviz

echo "▸ Vérification de santé (port ${PORT_VAL})"
for _ in $(seq 1 10); do
  if curl -fsS "http://127.0.0.1:${PORT_VAL}/health" >/dev/null; then
    echo "✓ Déployé — $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 1
done
echo "✗ Le service ne répond pas sur /health — voir: journalctl -u poeviz -e" >&2
exit 1
