#!/usr/bin/env bash
#
# Déploiement en UNE commande, depuis le poste local :
#     ./deploy/redeploy.sh
# = `git push origin main` puis, par SSH, `update.sh` sur le VPS.
#
# Cible SSH configurable (défaut ci-dessous) :
#     DEPLOY_SSH=monuser@poeviz.edito-revue.fr ./deploy/redeploy.sh
# L'utilisateur SSH doit pouvoir redémarrer le service sans mot de passe
# (cf. la règle sudoers dans deploy/README.md).
set -euo pipefail

DEPLOY_SSH="${DEPLOY_SSH:-poeviz@poeviz.edito-revue.fr}"
BRANCH="${BRANCH:-main}"

echo "▸ git push origin ${BRANCH}"
git push origin "${BRANCH}"

echo "▸ Déploiement sur ${DEPLOY_SSH}"
ssh "${DEPLOY_SSH}" 'cd /srv/poeviz && ./deploy/update.sh'
