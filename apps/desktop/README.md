<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- SPDX-FileCopyrightText: 2026 Jean Leloup -->
# Savoire, version bureau

La version bureau est **l'application web elle-même** (`apps/web`) dans une
fenêtre Tauri 2. Ce dossier ne contient que la coquille :

- `src-tauri/` : le programme Rust. Il ouvre la fenêtre et donne à la page
  un accès **limité aux dossiers de vault choisis par la personne** ;
- `src/` : le côté page de ce pont (`@savoire/desktop`) : l'implémentation
  Tauri du port `IVaultFileSystem`, et l'« hôte bureau » (choisir un dossier,
  vaults récents). L'app web ne le charge que dans Tauri (import dynamique).

Dans Tauri, l'app démarre d'office en **profil bureau**, un profil
**unifié** : les vaults de l'ordinateur et ceux du compte serveur, dans la
même session de l'app, sans rechargement.

- **Vaults locaux** : un vault = un dossier du disque (format Obsidian +
  `.savoire/`), aucun compte requis. Au lancement, l'app rouvre le dernier.
- **Bouton serveur** (barre du haut, toujours visible) : il montre le serveur
  et le compte connectés, ou « Hors ligne · non connecté ». Il ouvre une
  fenêtre : serveurs déjà utilisés, saisie d'une adresse
  (`http://127.0.0.1:5000` par défaut), e-mail, mot de passe, « Se
  connecter », « Se déconnecter ». On s'y connecte **à tout moment**, sans
  quitter le vault ouvert.
- **Un seul compte à la fois** : se connecter avec un autre compte, ou à un
  autre serveur, remplace le précédent (sa session est révoquée et effacée
  du poste). En cas d'échec, rien ne change.
- **Liste des vaults** (panneau de gauche) : un onglet par source,
  « Sur cet ordinateur » (« Ouvrir un dossier… », « + Nouveau vault… ») et
  le serveur (« + Nouveau vault sur le serveur », ou « Se connecter… »). Le
  point « ● » marque l'onglet du vault ouvert ; la barre du haut affiche aussi
  sa source à côté de son nom.
- **Se connecter** ajoute les vaults du compte à la liste. **Se
  déconnecter** les retire ; un vault du serveur ouvert se ferme, avec un
  message, un vault local reste ouvert.
- **Copier** (menu ⚙ d'un vault) : « Télécharger sur ce poste… » pour un
  vault du serveur (dans un nouveau dossier, qui apparaît dans « Sur cet
  ordinateur ») ; « Envoyer sur le serveur… » pour un vault local.
- **Menu du compte** (avatar, en bas à gauche) : le compte local, le compte
  serveur s'il y en a un, « Changer de serveur ou de compte… », « Se
  déconnecter du serveur ». Pas de liste de comptes à basculer sur le
  bureau (le navigateur la garde).

Côté code : `createDesktopRoot.ts`. `UnifiedVaultsBackend` (liste =
dossiers + vaults du compte, chaque vault marqué par sa source),
`UnifiedVaultSessionFactory` (un identifiant `disk:<chemin>` ouvre une
`FileSystemVaultSession`, tout autre identifiant une session serveur avec le
jeton, le compte et la clé d'identité du compte connecté). Le compte de
l'app reste le compte local (réglages, raccourcis, plugins personnels). La
connexion : `desktopConnection.ts` ; la fenêtre : `DesktopServerDialog.tsx`.

## Adresse du serveur

La fenêtre du bouton serveur (et l'écran de connexion, s'il apparaît)
demande l'**adresse du serveur**
(`https://savoire.exemple.fr`, `http://192.168.1.10:5000`). Sans `http://`
ni `https://`, `https://` est supposé. Les adresses déjà utilisées sont
proposées (10 au plus) ; la dernière est choisie au lancement suivant. La
session du compte est gardée : la personne reste connectée après un
redémarrage. Si le serveur ne répond pas au lancement, le bouton affiche
« Hors ligne » et la fenêtre propose « Réessayer ». En développement,
l'adresse par défaut est celle du Vite (`http://127.0.0.1:3002`), dont le
proxy mène au backend.

Dans le paquet installé, l'adresse par défaut est `http://127.0.0.1:5000` :
le serveur n'est pas exposé publiquement, on le joint par un tunnel SSH
(`ssh -L 5000:localhost:5000 <machine du serveur>`). Sans ce tunnel,
l'adresse ne mène nulle part.

Toutes les URL du client (REST et SignalR) passent par cette adresse
(`serverUrl` / `setServerBaseUrl`, `packages/infrastructure-sync/src/serverAddress.ts`).
Dans le navigateur, rien ne change : URL relatives.

Côté serveur, CORS doit accepter l'origine de l'app : `tauri://localhost`
(macOS, Linux) ou `http://tauri.localhost` (Windows). C'est le cas par
défaut (réglage `DesktopAppOrigins`, voir `SELF_HOSTING.md`).

## Prérequis

- Rust stable (1.77.2 au moins) : `rustup`, `cargo`.
- Linux : `libwebkit2gtk-4.1-dev`, `libssl-dev`, `librsvg2-dev`,
  `libayatana-appindicator3-dev`, `libxdo-dev`, `build-essential`.
- macOS : les outils en ligne de commande de Xcode (`xcode-select --install`).
- Windows : « Build Tools for Visual Studio » avec la charge de travail
  « Développement Desktop en C++ », et WebView2 (déjà présent sur
  Windows 10 et 11).
- Node 20 ou plus et pnpm (`corepack enable`), puis `cd frontend && pnpm install`
  (EdgeSync n'est pas nécessaire).

Une application macOS ou Windows se construit sur son propre système : pas
de compilation croisée depuis Linux.

## Lancer en développement

La fenêtre charge le Vite de l'app web sur `http://127.0.0.1:3002`
(`build.devUrl`). Lancez-le d'abord, puis la coquille :

```sh
# 1. l'app web (le proxy /api vers le backend sur :5000 sert au profil serveur)
cd apps/web && ./node_modules/.bin/vite --port 3002 --strictPort --host 127.0.0.1

# 2. la fenetre
cd apps/desktop && ./node_modules/.bin/tauri dev
# ou, sans le CLI : cd apps/desktop/src-tauri && cargo run
```

Sans écran (CI, serveur) : `Xvfb :99 &`, puis `DISPLAY=:99 dbus-run-session -- ./target/debug/savoire-desktop`.
Sans session D-Bus, la fenêtre ne s'ouvre pas.

## Construire

```sh
cd apps/desktop && ./node_modules/.bin/tauri build
```

`beforeBuildCommand` construit d'abord l'app web (`vite build`, dans
`apps/web/dist`), embarquée dans le binaire. Paquets produits, selon le
système (`"targets": "all"`) : `.deb`, `.rpm` et `.AppImage` sur Linux,
`.app` et `.dmg` sur macOS, installeurs `.msi` et `.exe` (NSIS) sur Windows,
dans `src-tauri/target/release/bundle/`.

Les paquets ne sont pas signés. macOS : au premier lancement, clic droit >
Ouvrir (ou `xattr -cr Savoire.app`). Windows : SmartScreen demande une
confirmation (« Informations complémentaires » > « Exécuter quand même »).

Tests Rust (chemins, liste des vaults, surveillance) : `cd src-tauri && cargo test`.

Compilation automatique : `.github/workflows/desktop.yml` construit l'appli
sur Linux, macOS et Windows (machines GitHub) à chaque push sur `master` qui
touche le front, et à la demande (onglet Actions > Desktop > Run workflow).
Les installeurs sont dans les « Artifacts » du lancement ; un tag `v*` les
publie aussi dans une Release.
Tests front : `tests/frontend/unit/desktop-tests` (`vitest run`).

## Android

La même coquille Tauri produit une app Android, **serveur seulement** :
pas de vault local, pas de choix de dossier ni de surveillance du disque.
L'app démarre en profil serveur (écran de connexion, vaults du compte),
avec l'adresse du serveur à saisir et la session gardée, comme sur le
bureau. Par défaut : `http://127.0.0.1:5000`, à joindre par un tunnel SSH
lancé sur le téléphone (par exemple une redirection de port locale
5000 → `localhost:5000` de la machine du serveur).

Côté code : `src-tauri/src/lib.rs` (les commandes de dossier sont réservées
au bureau, Android n'a que celles des serveurs), `isAndroidRuntime`
(`apps/web/src/tauriRuntime.ts`) et `initProfile` (`apps/web/src/profile.ts`).

Construction : le job « Android » de `.github/workflows/desktop.yml` génère
le projet Android (`src-tauri/gen/android`, ignoré par git) puis un **APK
de debug** pour `arm64`, dans les « Artifacts » du lancement. Il est signé
par la clé de debug (installable tel quel, après avoir autorisé les sources
inconnues) et accepte le `http` en clair, nécessaire pour le tunnel. En
local, il faut le SDK et le NDK Android (`ANDROID_HOME`, `NDK_HOME`), Java
17 et `rustup target add aarch64-linux-android`, puis :

```sh
cd apps/desktop
./node_modules/.bin/tauri android init --ci
./node_modules/.bin/tauri android build --debug --apk --target aarch64
```

## Où sont les données

- **Les notes** : dans le dossier du vault, en clair. Ce que le texte ne porte
  pas (état CRDT, identifiants) est dans `<vault>/.savoire/`. Les écritures
  sont atomiques (fichier temporaire dans `.savoire/tmp/`, puis renommage).
- **La liste des vaults récents** : `recent-vaults.json` dans le dossier de
  configuration de l'application (Linux : `~/.config/org.savoire.desktop/`,
  macOS : `~/Library/Application Support/org.savoire.desktop/`).
- **Les serveurs connus** : `servers.json`, au même endroit. **Les sessions**
  (comptes connectés, jeton de renouvellement compris) : `server-sessions.json`,
  droits `0600` sous Linux et macOS. Ce n'est pas le trousseau du système :
  Tauri n'a pas de greffon officiel léger pour ça, il faudrait une
  dépendance de plus. Le fichier est lisible par les programmes de la
  personne, comme le stockage d'un navigateur. « Se déconnecter » l'efface.
- **Le reste de l'app** (réglages, clé d'identité locale, index plein texte) :
  stockage de la fenêtre (Linux : `~/.local/share/org.savoire.desktop/`).

## Sécurité

- Aucun plugin `fs` Tauri : la page n'a pas d'accès libre au disque. Elle
  appelle des commandes Rust (`src-tauri/src/vault_fs.rs`) qui n'acceptent
  qu'une **racine autorisée** et un **chemin relatif** (refus de `..`, des
  chemins absolus et des liens symboliques qui sortent du vault).
- Une racine n'est autorisée que si la personne l'a choisie dans la boîte de
  dialogue native (ouverte côté Rust, jamais depuis la page), ou si elle est
  déjà dans sa liste de vaults récents. Aucune commande ne permet à la page
  d'ajouter un chemin.
- Capacités (`src-tauri/capabilities/default.json`) : les commandes de vault,
  celles des serveurs (`src-tauri/src/servers.rs` : deux fichiers fixes, aucun
  chemin venu de la page) et l'écoute d'événements, rien d'autre (ni dialogue,
  ni shell, ni http).
- CSP (`tauri.conf.json`) : tout est limité à `'self'`, sauf `connect-src`,
  ouvert à `http: https: ws: wss:`. Une CSP est fixe, alors que l'adresse du
  serveur est choisie à l'exécution. Le compromis : la page peut ouvrir une
  connexion vers n'importe quel hôte, mais elle ne peut charger aucun script,
  style, image ou cadre d'ailleurs. Passer tout le réseau par une commande
  Rust aurait demandé un client HTTP et un client SignalR côté Rust, pour un
  gain faible : le code de la page est déjà celui du paquet.
- « Supprimer » un vault local le retire de la liste ; le dossier n'est
  jamais effacé.

## Limites

- Un seul compte serveur à la fois, et un seul serveur à la fois.
- « Administration » (menu du compte) quitte l'espace de travail ; au
  retour, l'app rouvre le dernier vault local, pas un vault du serveur.
- Un certificat invalide, un serveur éteint, une mauvaise adresse ou une
  origine refusée par CORS donnent la même erreur réseau au navigateur :
  le message de connexion les cite toutes, sans pouvoir dire laquelle.
- Le module ancien `plugin-module` (cadres `/share/...`) n'est pas passé à
  l'adresse du serveur : il ne marche pas dans l'app de bureau installée.
- Les liens symboliques ne sont pas suivis dans un vault.
- Une écriture atomique est vue par la surveillance comme une création
  (renommage), pas comme une modification.
- Un dossier déplacé ou renommé hors de l'app doit être rouvert
  (« Ouvrir un dossier… ») ; l'ancienne entrée apparaît « introuvable ».
