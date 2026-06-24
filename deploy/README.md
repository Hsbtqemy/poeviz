# Déploiement — VPS Ubuntu (`poeviz.edito-revue.fr`)

Guide pas-à-pas pour un **VPS Lite Infomaniak** (Ubuntu, accès SSH root, IPv4 + IPv6).
Cible : servir l'app sur **https://poeviz.edito-revue.fr** derrière nginx, en HTTPS.

> Rappel d'architecture : **un seul process Python**, état en mémoire, pas de base de
> données. Ne pas multiplier les workers. Un redémarrage remet les sessions à zéro
> (outil d'exploration). Les données restent sur ton serveur — rien n'est envoyé à des
> tiers (libs front vendorisées, aucun appel CDN).

Fichiers fournis ici : [`.env.example`](.env.example), [`poeviz.service`](poeviz.service),
[`nginx.conf.example`](nginx.conf.example).

---

## 1. DNS — créer le sous-domaine (gratuit)

Dans le gestionnaire DNS de `edito-revue.fr` (interface Infomaniak), ajouter :

| Type | Nom | Valeur |
|------|--------|--------------------|
| `A`    | `poeviz` | `<IPv4-du-VPS>` |
| `AAAA` | `poeviz` | `<IPv6-du-VPS>` |

Propagation : quelques minutes. Vérifier : `dig +short poeviz.edito-revue.fr`.

## 2. Préparer le serveur + déposer le code

```bash
ssh root@<IPv4-du-VPS>
apt update && apt install -y python3-venv git nginx curl

# Récupérer le code (git crée le dossier /srv/poeviz).
git clone https://github.com/Hsbtqemy/poeviz.git /srv/poeviz

# Utilisateur dédié `poeviz` : possède le code, fait tourner le service ET reçoit les
# déploiements SSH. Son home est le dossier déjà cloné (adduser ne le réécrase pas).
adduser --home /srv/poeviz --shell /bin/bash --disabled-password --gecos "" poeviz
chown -R poeviz:poeviz /srv/poeviz

# Autoriser ta clé SSH pour cet utilisateur (déploiement depuis ton poste) :
sudo -u poeviz install -d -m 700 /srv/poeviz/.ssh
# … puis coller ta clé publique dans /srv/poeviz/.ssh/authorized_keys (owner poeviz).
```

## 3. Environnement Python

```bash
cd /srv/poeviz
sudo -u poeviz python3 -m venv .venv
sudo -u poeviz .venv/bin/pip install -r requirements.txt
sudo -u poeviz chmod +x deploy/*.sh        # scripts de déploiement exécutables
```

## 4. Configuration (`.env`)

```bash
sudo -u poeviz cp deploy/.env.example /srv/poeviz/.env
# éditer /srv/poeviz/.env si besoin — par défaut : HOST=127.0.0.1 PORT=8000
#                                     ALLOWED_ORIGINS=https://poeviz.edito-revue.fr
```

## 5. Service systemd (démarrage auto + redémarrage)

```bash
cp deploy/poeviz.service /etc/systemd/system/poeviz.service
systemctl daemon-reload
systemctl enable --now poeviz
systemctl status poeviz            # doit être "active (running)"
curl -s http://127.0.0.1:8000/health   # -> {"status":"ok",...}
```

## 6. nginx en reverse-proxy

```bash
cp deploy/nginx.conf.example /etc/nginx/sites-available/poeviz
ln -s /etc/nginx/sites-available/poeviz /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 7. HTTPS (Let's Encrypt, gratuit)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d poeviz.edito-revue.fr
# certbot ajoute le bloc 443 (TLS) + la redirection 80 -> 443, et gère le renouvellement.
```

## 8. Pare-feu

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'      # ouvre 80 + 443 ; le 8000 reste privé (jamais exposé)
ufw enable
```

C'est en ligne : **https://poeviz.edito-revue.fr** 🎉

---

## Déploiement continu (depuis un `git push`)

Deux scripts (dans `deploy/`) automatisent les mises à jour.

**Réglage unique** — autoriser `poeviz` à redémarrer *uniquement* son service sans mot
de passe (nécessaire pour un déploiement non interactif) :

```bash
echo 'poeviz ALL=(root) NOPASSWD: /usr/bin/systemctl restart poeviz' \
  | sudo tee /etc/sudoers.d/poeviz-deploy
sudo chmod 440 /etc/sudoers.d/poeviz-deploy
```

**Usage** — deux entrées possibles :

```bash
# A. Sur le serveur : récupère origin/main, deps, restart, test de santé.
ssh poeviz@poeviz.edito-revue.fr 'cd /srv/poeviz && ./deploy/update.sh'

# B. Depuis ton poste, en UNE commande : git push + déploiement (recommandé).
DEPLOY_SSH=poeviz@poeviz.edito-revue.fr ./deploy/redeploy.sh
```

`update.sh` fait `git reset --hard origin/main` (le serveur reflète exactement git ;
`.env` et `.venv/`, ignorés par git, sont préservés), réinstalle les dépendances,
redémarre, puis vérifie `/health`.

> **Option C — push-to-deploy 100 % auto** (non mis en place ici) : une *GitHub Action*
> qui, à chaque push sur `main`, se connecte en SSH et lance `update.sh`. Plus
> automatique, mais ça impose de **confier une clé SSH du VPS aux secrets GitHub** — à
> peser face à l'esprit « rien chez un tiers ». Un hook git `post-receive` (push direct
> vers le VPS) est l'alternative sans tiers. Dis-le si tu veux l'une ou l'autre.

## Dépannage

- **502 Bad Gateway** → le service est arrêté : `systemctl status poeviz`, `journalctl -u poeviz -e`.
- **413 Request Entity Too Large** → `client_max_body_size` (nginx) < taille du `.xlsx` ;
  l'exemple est à 30 Mo, au-dessus des 25 Mo de l'app.
- **Certificat** : renouvellement auto via le timer `certbot.timer` (`systemctl list-timers`).
