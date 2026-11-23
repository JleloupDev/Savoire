# Héberger Savoire

Savoire tourne sur une seule machine avec Docker Compose. Les images sont
publiées par la CI sur `ghcr.io`. Rien n'est construit sur le serveur.

Le choix de cette architecture est expliqué dans
`docs/Architecture/ADR/ADR-028-publication-et-identites.md`.

## Ce qui tourne

| Service | Rôle |
|---|---|
| `caddy` | Entrée HTTPS (certificats Let's Encrypt automatiques), ports 80 et 443 |
| `web` | L'application (page web), qui relaie `/api` et `/hubs` vers l'API |
| `api` | Le serveur (Rust) : vaults, synchro temps réel, droits |
| `indexer` | Le pair indexeur (recherche, bases), jamais exposé |
| `postgres` | Les données de Savoire et de Zitadel (deux bases) |
| `zitadel`, `zitadel-login` | Les comptes : inscription et connexion (fournisseur, lien par mail, clé d'accès) |
| `zitadel-bootstrap` | Prépare Zitadel pour Savoire au démarrage, puis s'arrête |
| `backup` | Sauvegarde de nuit des bases et des fichiers |
| `portainer` | Administration des conteneurs (interface web), sur 127.0.0.1 seulement |

Et pour l'exploitation (`docker-compose.ops.yml`, voir [Exploitation](#exploitation)) :

| Service | Rôle |
|---|---|
| `offsite` | Copie chiffrée des sauvegardes hors de la machine (restic) |
| `glitchtip`, `glitchtip-bootstrap` | Suivi des erreurs (web, bureau, serveur, pair indexeur) |
| `prometheus`, `alertmanager` | Métriques et alertes par courriel |
| `loki`, `alloy` | Journaux de tous les conteneurs |
| `grafana` | Tableaux de bord |
| `node-exporter`, `cadvisor`, `postgres-exporter`, `blackbox` | Mesures de la machine, des conteneurs, de la base, sondes des services |

Savoire ne gère aucun mot de passe. Les comptes vivent dans Zitadel, le
fournisseur d'identité. Savoire garde les vaults, les membres et les droits.

## Installer sur un VPS, automatiquement

Sur une machine neuve (Debian 12 ou 13, Ubuntu 22.04 ou 24.04), depuis
votre compte qui a sudo (`ubuntu` chez Oracle), avec votre clé SSH :

```bash
curl -fsSL https://raw.githubusercontent.com/JleloupDev/Savoire/master/deploy/vps/install.sh -o install.sh
sudo bash install.sh
```

Le script prépare la machine (mises à jour de sécurité automatiques,
pare-feu, fail2ban, Docker rootless, le compte `savoire`, SSH par clé
seulement, mémoire d'échange), pose les questions (domaines, adresse,
Brevo, stockage de la copie hors machine), génère tous les secrets, puis
démarre Savoire et son exploitation. Relance sans risque.

Machine conseillée : 4 cœurs, **8 Go de mémoire**, 80 Go de disque SSD.

Avant de lancer : les deux noms de domaine pointent vers la machine, et le
domaine d'envoi des courriels est vérifié chez Brevo (voir
[Courriels](#courriels-brevo)).

Les scripts de `deploy/vps/` :

| Script | Rôle |
|---|---|
| `install.sh` | Installation complète ; `--restore` : depuis la copie hors machine |
| `configure.sh` | Questions et secrets (`deploy/compose/.env`), relance sans risque |
| `update.sh` | Mise à jour : sauvegarde, puis nouvelles images |
| `check.sh` | État : services, site, alertes en cours, âge des sauvegardes |
| `restore.sh` | Restauration complète depuis la copie hors machine |
| `restore-test.sh` | Test de restauration (chaque dimanche, minuterie systemd) |

La suite de ce guide décrit l'installation à la main.

## Comptes et droits

| Compte | Rôle | sudo |
|---|---|---|
| le vôtre (`ubuntu` chez Oracle) | Administration de la machine, SSH par clé | oui |
| `savoire` | Possède `/opt/savoire`, le `.env`, les sauvegardes ; fait tourner Docker | non |

- **Docker rootless** : le compte `savoire` a son propre Docker, lancé par
  sa session systemd (active sans connexion). Aucun conteneur ne tourne en
  root ; le Docker root de la machine est arrêté. Un conteneur qui
  s'échapperait n'aurait que les droits de `savoire`.
- Ce compte n'a ni mot de passe ni sudo. Pour agir sous lui :
  `sudo -iu savoire` (il arrive dans `deploy/compose`, `docker compose ...`
  marche). Les scripts de `deploy/vps/` lancés avec sudo passent d'eux-mêmes
  sous ce compte.
- Ports 80 et 443 sans root : `net.ipv4.ip_unprivileged_port_start=80`.
  Les ports passent par slirp4netns : Caddy voit la vraie adresse des
  visiteurs.
- Ubuntu 24.04 : un profil AppArmor (`/etc/apparmor.d/usr.bin.rootlesskit`)
  autorise le Docker du compte.
- Limite : cAdvisor (mémoire et processeur par conteneur) voit moins de
  choses qu'avec un Docker root.

## Déployer depuis GitHub (CI)

Les secrets vivent dans GitHub (environnement `production`), pas sur votre
poste ni dans le dépôt. Après chaque construction réussie des images sur
master, `.github/workflows/deploy.yml` déploie ce commit sur le serveur.

Avant : ports 80 et 443 ouverts chez l'hébergeur (Oracle : *Security List*
du VCN), DNS vers le serveur, domaine vérifié chez Brevo.

Sur votre poste, dans le dépôt, avec `gh` connecté (`gh auth login`) :

```bash
ENV_FILE=~/savoire-production.env bash deploy/vps/configure.sh
bash deploy/vps/github-secrets.sh ~/savoire-production.env --server ubuntu@<IP>
```

Le premier pose les questions (domaine, adresse, Brevo, S3 au besoin) et
génère tous les secrets. Le second, par votre connexion SSH :

1. envoie tout dans GitHub (mots de passe et clés en secrets, le reste en
   variables) et crée la clé SSH de déploiement (`DEPLOY_SSH_KEY`) ;
2. installe le serveur (`install.sh --ci`) : la clé de la CI est posée sur
   le compte `savoire` et ne peut lancer que `deploy/vps/ci-deploy.sh`, ni
   terminal, ni tunnel ;
3. déclare le serveur dans GitHub : `DEPLOY_HOST` et `DEPLOY_HOST_KEY`, la
   clé du serveur lue par votre connexion (la CI refuse tout autre serveur) ;
4. redémarre la machine si le pare-feu d'origine d'Oracle bloque encore 80
   et 443 ;
5. lance le premier déploiement et le suit jusqu'au bout.

Rangez ensuite le fichier dans un gestionnaire de mots de passe et
effacez-le : GitHub ne rend jamais un secret. Sans `--server`, le script
s'arrête après l'étape 1 et affiche la commande à lancer sur le serveur.

À chaque déploiement, `ci-deploy.sh` (sous `savoire`) :
- met les fichiers de déploiement au commit déployé ;
- refait le `.env` à partir de GitHub. Il refuse si un secret qui ouvre des
  données a changé (`ZITADEL_MASTERKEY`, mots de passe des bases,
  `RESTIC_PASSWORD`, clé du store) ;
- sauvegarde si Savoire tourne déjà ;
- tire les images `sha-<commit>` et redémarre ce qui a changé ;
- attend que l'API, le site et la connexion répondent (6 minutes au plus).

Changer un réglage : modifier la variable ou le secret dans GitHub
(*Settings → Environments → production*), puis *Run workflow*. Déployer une
version précise : *Run workflow* avec un commit ou une étiquette `v1.2.3`.
Les noms qui commencent par `GITHUB_` sont refusés par GitHub :
`GITHUB_CLIENT_ID` s'écrit `OAUTH_GITHUB_CLIENT_ID`.

## Nginx, Caddy et HTTPS

Rien à installer ni à configurer sur la machine : ni Nginx, ni certificat.

- **Caddy** (conteneur `caddy`) reçoit les ports 80 et 443. Il obtient et
  renouvelle seul les certificats Let's Encrypt de `SAVOIRE_DOMAIN` et
  `AUTH_DOMAIN`, et répartit vers les services. Sa configuration est dans
  le dépôt (`deploy/compose/caddy/Caddyfile`) et part avec chaque
  déploiement.
- **Nginx** tourne seulement *dans* l'image `web`, pour servir les pages de
  l'appli. Sa configuration est dans l'image.
- Un autre site sur la même machine (un blog…) : un bloc de plus dans le
  Caddyfile, son certificat se fait tout seul.
- Aucun Nginx ou Apache ne doit occuper 80 ou 443 sur la machine.

## Savoire Store

Le store (plugins, modèles, modules) se déploie avec Savoire
(`deploy/compose/docker-compose.store.yml`, dans `COMPOSE_FILE`). Son code
est pour l'instant dans ce dépôt (dossier `store/`). Il répond
sous l'adresse de Savoire, `https://SAVOIRE_DOMAIN/store/`, tant qu'il n'a pas
de domaine à lui. Ses comptes sont ceux de Savoire ; `ADMIN_EMAIL` relit les
publications.

- `configure.sh` génère sa clé de signature (`STORE_SIGNING_KEY`) et sa clé
  publique (`STORE_PUBLIC_KEY`). Elles partent dans la copie hors machine avec
  le `.env`. **Ne jamais les changer** : les applications refuseraient tous
  les paquets.
- Son image : `savoire-store` dans `SAVOIRE_REGISTRY`, à la même version que
  Savoire, ou construite depuis le dossier `store/` (`docker-compose.build.yml`).
- Le déploiement par la CI l'ajoute à `COMPOSE_FILE` dès que ses clés sont
  dans les secrets.
- Sa base, `savoire_store`, est dans le même PostgreSQL : elle est sauvegardée
  avec les autres.

## Import Notion (facultatif)

La version bureau peut se connecter à Notion pour importer des pages
(ADR-035). Le serveur garde le secret de l'intégration et fait l'échange du
code ; il ne garde aucun jeton.

1. Sur https://www.notion.so/profile/integrations, créez une intégration
   **publique**. Capacités : lecture du contenu seulement.
2. Adresse de retour : `https://SAVOIRE_DOMAIN/api/v1/notion/callback`.
3. Dans le `.env` : `NOTION_CLIENT_ID` et `NOTION_CLIENT_SECRET`
   (`NOTION_REDIRECT_URI` si l'adresse de retour est une autre).

Sans ces valeurs, la connexion à Notion n'est pas proposée ; l'import d'un
export `.zip` reste possible.

## Prérequis

- Une machine Linux avec Docker et le plugin Compose, 2 Go de RAM au moins
  (4 Go conseillés).
- Deux noms de domaine qui pointent vers elle, par exemple
  `savoire.exemple.fr` (l'appli) et `auth.exemple.fr` (la connexion).
- Les ports 80 et 443 ouverts. Aucun autre.
- Un service d'envoi de courriels (SMTP) : Brevo, Mailjet, Scaleway… Sans lui,
  personne ne peut vérifier son adresse ni recevoir de lien de connexion.

## Courriels (Brevo)

Brevo envoie gratuitement jusqu'à 300 courriels par jour : vérification
d'adresse, liens de connexion, invitations, alertes.

1. Créer un compte sur brevo.com.
2. *Expéditeurs, domaines et IP dédiées → Domaines* : ajouter votre domaine
   et poser chez votre registraire les enregistrements DNS indiqués (DKIM,
   code de vérification), plus :
   - SPF : `v=spf1 include:spf.brevo.com ~all` (à fusionner avec un SPF
     existant : un seul enregistrement SPF par domaine) ;
   - DMARC : `_dmarc` en TXT, `v=DMARC1; p=none; rua=mailto:<votre adresse>`.
   Sans eux, les courriels finissent en indésirables.
3. *SMTP & API → SMTP* : noter l'identifiant SMTP et créer une clé SMTP.
4. Dans `.env` : `SMTP_USER` (identifiant), `SMTP_PASSWORD` (clé),
   `SMTP_FROM` (une adresse du domaine vérifié). `configure.sh` les demande.

Serveur `smtp-relay.brevo.com`, port 465 (TLS dès la connexion). Le même
compte sert à Zitadel, à GlitchTip et aux alertes.

Zitadel ne lit sa configuration SMTP qu'à sa création : `zitadel-bootstrap`
la remet sur celle du `.env` à chaque déploiement. Changer la clé Brevo dans
GitHub suffit, puis *Run workflow*.

## Installer

```bash
git clone https://github.com/JleloupDev/Savoire.git
cd Savoire/deploy/compose
cp .env.example .env
$EDITOR .env        # domaines, administrateur, secrets, SMTP
docker compose --env-file .env up -d
```

Au premier démarrage, Zitadel prépare sa base (une à deux minutes), puis
`zitadel-bootstrap` crée le projet Savoire, ses applis et ses comptes de
service. L'API démarre ensuite.

- L'appli : `https://savoire.exemple.fr`.
- La console de Zitadel : `https://auth.exemple.fr/ui/console`, avec
  l'adresse `ADMIN_EMAIL` : un lien de connexion arrive par mail. Aucune page
  ne demande `ADMIN_PASSWORD` (voir l'ADR-031).

Ce compte (adresse `ADMIN_EMAIL`) est aussi administrateur de Savoire.
D'autres administrateurs : `Auth__AdminEmails__1=...` dans l'environnement de
l'API. Une adresse ne donne ce droit qu'une fois vérifiée.

## Administrer les conteneurs (Portainer)

Portainer pilote tout Docker : il n'est jamais exposé sur Internet. Il écoute
sur `127.0.0.1:9443` (`PORTAINER_PORT`). Depuis votre poste :

```bash
ssh -L 9443:127.0.0.1:9443 <utilisateur>@<serveur>
```

puis `https://localhost:9443` (certificat auto-signé, à accepter). Créez le
compte administrateur **dans les 5 minutes** qui suivent le premier
démarrage ; passé ce délai, Portainer se verrouille par sécurité :
`docker compose --env-file .env restart portainer` pour recommencer.

L'écran de création demande un jeton (*setup token*). Portainer l'écrit dans
ses journaux, et en tire un nouveau à chaque démarrage :

```bash
docker compose --env-file .env logs portainer | grep setup_token | tail -1
```

## Les comptes

- Aucun mot de passe. On entre de trois façons : un fournisseur (Google,
  Microsoft, GitHub…), un lien reçu par mail, ou une clé d'accès (passkey).
  Le lien ouvre une page qui montre un code, à taper dans la fenêtre où l'on
  a demandé à se connecter.
- Chacun crée son compte depuis l'écran de connexion (« Créer un compte ») :
  nom et adresse, puis le code du mail. Une clé d'accès est proposée ensuite.
- La page de connexion est celle de Zitadel, retouchée
  (`deploy/compose/zitadel-login/`, image `savoire-login`).
- Connexion avec Google, GitHub ou Microsoft :
  1. Déclarer une appli chez le fournisseur (quelques minutes), avec
     l'adresse de retour `https://auth.exemple.fr/idps/callback`.
  2. Dans `.env` : `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` (de même
     `GITHUB_…`, `MICROSOFT_…`).
  3. `docker compose up -d zitadel-bootstrap` : le bouton « Google » apparaît
     sur la page de connexion. Un compte est créé à la première connexion.
  Vider les deux variables puis relancer retire le bouton.
- Fermer l'inscription libre : console, *Paramètres → Paramètres de
  connexion*, décocher « Enregistrement autorisé ».
- Bloquer un compte dans Savoire : page Administration de l'appli. Ses
  jetons sont refusés aussitôt, même encore valides chez Zitadel.

## Les secrets

| Variable | Rôle | Changer plus tard ? |
|---|---|---|
| `ZITADEL_MASTERKEY` | Chiffre les secrets de Zitadel, 32 caractères exactement | Jamais : le perdre, c'est perdre Zitadel |
| `POSTGRES_PASSWORD`, `SAVOIRE_DB_PASSWORD`, `ZITADEL_DB_PASSWORD` | Base de données | Oui, dans PostgreSQL puis ici |
| `LOGIN_COOKIE_SECRET` | Cookie de la page de connexion | Oui (les sessions en cours se ferment) |
| `JWT_SECRET` | Liens de partage et vues intégrées | Oui (les liens déjà donnés cessent de marcher) |

Générer un secret : `openssl rand -base64 48 | tr -d '/+=' | cut -c1-32`.

## Sauvegardes

Le service `backup` sauvegarde quatre fois par jour (heures `BACKUP_TIMES`,
UTC : par défaut 03:30, 09:30, 15:30 et 21:30, donc au pire 6 heures
perdues) dans `BACKUP_DIR` :

- `savoire-<date>-db.sql.gz` : les bases (Savoire, Zitadel, store) ;
- `savoire-<date>-files.tar.gz` : les fichiers des vaults (pièces jointes) ;
- `savoire-<date>-zitadel.tar.gz` : les jetons de service de Zitadel. Il ne
  les écrit qu'à sa toute première installation : sans eux, une base
  restaurée sur une autre machine ne redémarre pas.

Une sauvegarde n'est comptée réussie que si l'export est complet et relu.
Les fichiers ne sont lisibles que par le compte `savoire`. Il garde `BACKUP_KEEP_DAYS` jours. Une sauvegarde sur le même disque ne
protège pas d'une panne de disque : avec `docker-compose.ops.yml`, le
service `offsite` en fait une copie hors de la machine (voir plus bas).

### Copie hors de la machine

Après chaque sauvegarde locale, `offsite` (restic) envoie vers un stockage
S3 en Europe (Scaleway, OVH, Hetzner…) l'export des bases, les fichiers des
vaults, le `.env` et les jetons de Zitadel. La copie est chiffrée avec `RESTIC_PASSWORD` et
dédoublonnée : seules les différences partent. Il garde 7 jours, 4 semaines
et 6 mois, et vérifie le dépôt chaque dimanche.

1. Créer un compartiment (*bucket*) privé et une clé d'accès chez
   l'hébergeur choisi.
2. Dans `.env` : `RESTIC_REPOSITORY` (par exemple
   `s3:https://s3.fr-par.scw.cloud/mon-bucket/savoire`),
   `RESTIC_S3_ACCESS_KEY`, `RESTIC_S3_SECRET_KEY`, `RESTIC_S3_REGION`.
3. **Garder `RESTIC_PASSWORD` hors de la machine** (gestionnaire de mots de
   passe) : sans lui, la copie est illisible.

Copier tout de suite : `docker compose run --rm offsite now`.
Lister les copies : `docker compose run --rm offsite snapshots`.

Chaque dimanche, `restore-test.sh` relit la dernière copie, recharge les
bases dans un PostgreSQL jetable et vérifie leur contenu. Une alerte part
si ce test n'a pas réussi depuis 8 jours.

### Tout réinstaller depuis la copie

Sur une machine neuve (les domaines pointent vers elle) :

```bash
sudo bash install.sh --restore
```

Le script demande le dépôt, ses clés et `RESTIC_PASSWORD`, remet le `.env`,
les bases et les fichiers, puis démarre tout.

Sauvegarder tout de suite : `docker compose --env-file .env run --rm backup now`.

L'index du pair n'est pas sauvegardé : il se reconstruit tout seul.

### Restaurer

**Sur une machine neuve, depuis la copie hors machine** (le cas d'une panne
totale) : `sudo deploy/vps/install.sh --restore`, ou `sudo deploy/vps/restore.sh`
si Docker est déjà là. Il demande l'adresse du dépôt, ses clés S3 et
`RESTIC_PASSWORD` (gardés hors de la machine), remet le `.env`, les bases,
les fichiers des vaults et les jetons de Zitadel, démarre tout et vérifie que
l'API répond. Les comptes, les mots de passe et les vaults reviennent tels
quels. Répété le 17/11/2026 : machine effacée, restaurée, connexion et notes
retrouvées.

Une copie faite avant le 17/11/2026 n'a pas les jetons de Zitadel :
`restore.sh` s'arrête et le dit.

**Sur la même machine, depuis une sauvegarde locale** :

```bash
docker compose --env-file .env stop api indexer zitadel zitadel-login
gunzip -c backups/savoire-<date>-db.sql.gz \
  | docker compose --env-file .env exec -T postgres psql -U postgres -d postgres
docker run --rm -v savoire_savoire-data:/data -v "$PWD/backups:/b:ro" alpine:3.22 \
  sh -c 'rm -rf /data/* && tar -C /data -xzf /b/savoire-<date>-files.tar.gz'
docker compose --env-file .env up -d
```

## Exploitation

`docker-compose.ops.yml` s'ajoute à `docker-compose.yml`. `configure.sh`
écrit `COMPOSE_FILE=docker-compose.yml:docker-compose.ops.yml` dans `.env` :
`docker compose ...` utilise alors les deux. Rien n'est exposé sur Internet ;
depuis votre poste :

```bash
ssh -L 3000:127.0.0.1:3000 -L 8100:127.0.0.1:8100 savoire@<serveur>
```

### Tableaux de bord (Grafana)

`http://localhost:3000`, identifiant `admin`, mot de passe
`GRAFANA_ADMIN_PASSWORD`. Dossier *Savoire* :

- **Vue d'ensemble** : services en ligne (sondes internes et publiques),
  requêtes, erreurs et temps de réponse de l'API, connexions temps réel,
  machine (processeur, mémoire, disque, réseau), mémoire par conteneur,
  base, retard du pair indexeur, âge des sauvegardes, erreurs récentes.
- **Journaux** : tous les conteneurs, filtrés par service et par texte,
  gardés 30 jours.

Métriques gardées `METRICS_RETENTION` (30 jours).

### Suivi des erreurs (GlitchTip)

`http://localhost:8100`, identifiant `ADMIN_EMAIL`, mot de passe
`GLITCHTIP_ADMIN_PASSWORD`. Trois projets, créés tout seuls :

- **web** : les erreurs de l'appli dans le navigateur et dans l'appli de
  bureau. Elles passent par l'API (`/api/v1/errors/envelope`), qui les
  relaie : GlitchTip reste invisible depuis Internet.
- **api** : le serveur (exceptions, journaux d'erreur). Depuis la réécriture en Rust, l'API n'envoie plus ses propres erreurs à GlitchTip (voir ADR-032) ; ses journaux restent dans `docker logs`.
- **indexer** : le pair indexeur.

Aucun contenu de note, aucune adresse IP, aucun cookie n'est envoyé : la pile
d'appels, le navigateur, la version. Chaque nouvelle erreur est envoyée par
courriel. Événements gardés 90 jours.

### Alertes

Par courriel à `ALERT_EMAIL`. Critiques : site injoignable, service arrêté,
taux d'erreurs du serveur, base injoignable, disque plein, sauvegarde ou
copie hors machine manquée. À regarder : serveur lent, mémoire, processeur,
certificat bientôt expiré, pair indexeur en retard, conteneur qui redémarre
en boucle, test de restauration manqué. Règles :
`deploy/compose/ops/prometheus/rules/savoire.yml`.

Ces alertes tombent avec la machine. Ajoutez une surveillance extérieure
gratuite (UptimeRobot, Better Stack…) sur `https://<SAVOIRE_DOMAIN>/`.

## Mettre à jour

Avec la CI (voir plus haut), rien à faire : chaque image construite sur
master est déployée. Sans la CI :

```bash
sudo bash deploy/vps/update.sh
```

Le script sauvegarde d'abord, récupère les fichiers de déploiement, tire les
nouvelles images et redémarre ce qui a changé. À la main :

```bash
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

`SAVOIRE_VERSION` choisit la version : `latest` (branche principale), une
version (`v1.2.0`) ou un commit (`sha-abc1234`). Les migrations de la base
s'appliquent au démarrage de l'API. Sauvegardez avant une mise à jour.

## Construire depuis les sources

```bash
docker compose --env-file .env -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Essayer sur un poste, sans domaine

`docker-compose.local.yml` lance la même pile en http sur `127.0.0.1:8480`
(appli : `http://savoire.localhost:8480`, connexion :
`http://auth.localhost:8480`, courriels : Mailpit sur `127.0.0.1:8425`). Pour
essayer seulement, jamais en production.

## Développer

Le poste de développement n'a besoin que de PostgreSQL et de Zitadel :

```bash
docker compose -f deploy/compose/docker-compose.dev.yml up -d --wait
```

Voir l'en-tête de ce fichier pour les adresses et le compte de dev.
