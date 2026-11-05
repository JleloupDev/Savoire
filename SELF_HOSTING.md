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
| `api` | Le backend .NET : vaults, synchro temps réel, droits |
| `indexer` | Le pair indexeur (recherche, bases), jamais exposé |
| `postgres` | Les données de Savoire et de Zitadel (deux bases) |
| `zitadel`, `zitadel-login` | Les comptes : inscription, connexion, mot de passe oublié |
| `zitadel-bootstrap` | Prépare Zitadel pour Savoire au démarrage, puis s'arrête |
| `backup` | Sauvegarde de nuit des bases et des fichiers |
| `portainer` | Administration des conteneurs (interface web), sur 127.0.0.1 seulement |

Savoire ne gère aucun mot de passe. Les comptes vivent dans Zitadel, le
fournisseur d'identité. Savoire garde les vaults, les membres et les droits.

## Prérequis

- Une machine Linux avec Docker et le plugin Compose, 2 Go de RAM au moins
  (4 Go conseillés).
- Deux noms de domaine qui pointent vers elle, par exemple
  `savoire.exemple.fr` (l'appli) et `auth.exemple.fr` (la connexion).
- Les ports 80 et 443 ouverts. Aucun autre.
- Un service d'envoi de courriels (SMTP) : Brevo, Mailjet, Scaleway… Sans lui,
  personne ne peut vérifier son adresse, donc personne ne peut s'inscrire.

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
- La console de Zitadel : `https://auth.exemple.fr/ui/console`, identifiant
  `ADMIN_EMAIL`, mot de passe `ADMIN_PASSWORD`.

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

- Chacun crée son compte depuis l'écran de connexion (« Créer un compte »).
  L'adresse est vérifiée par un code envoyé par courriel.
- Mot de passe oublié, double authentification, passkeys : sur la page de
  connexion de Zitadel.
- Connexion avec Google, GitHub ou Microsoft : dans la console de Zitadel,
  *Paramètres → Fournisseurs d'identité*. Il faut d'abord déclarer une appli
  chez le fournisseur choisi (quelques minutes), avec l'adresse de retour que
  Zitadel indique.
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

Le service `backup` sauvegarde chaque nuit (heure `BACKUP_AT`, UTC) dans
`BACKUP_DIR` :

- `savoire-<date>-db.sql.gz` : les deux bases (Savoire et Zitadel) ;
- `savoire-<date>-files.tar.gz` : les fichiers des vaults (pièces jointes).

Il garde `BACKUP_KEEP_DAYS` jours. **Recopiez ce dossier hors de la machine**
(rclone, restic, ou la sauvegarde de votre hébergeur) : une sauvegarde sur le
même disque ne protège pas d'une panne de disque.

Sauvegarder tout de suite : `docker compose --env-file .env run --rm backup now`.

L'index du pair n'est pas sauvegardé : il se reconstruit tout seul.

### Restaurer

```bash
docker compose --env-file .env stop api indexer zitadel zitadel-login
gunzip -c backups/savoire-<date>-db.sql.gz \
  | docker compose --env-file .env exec -T postgres psql -U postgres -d postgres
docker run --rm -v savoire_savoire-data:/data -v "$PWD/backups:/b:ro" alpine:3 \
  sh -c 'rm -rf /data/* && tar -C /data -xzf /b/savoire-<date>-files.tar.gz'
docker compose --env-file .env up -d
```

## Mettre à jour

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
