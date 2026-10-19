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

Dans Tauri, l'app démarre d'office en **profil bureau** : un vault = un
dossier du disque (format Obsidian + `.savoire/`), aucun compte requis. Elle
rouvre le dernier vault ; sinon elle affiche l'écran « Vaults sur cet
ordinateur » (dossiers récents, « Ouvrir un dossier… », « Nouveau vault… »).
Le bouton « Serveur Savoire… » recharge l'app en profil serveur
(`?profile=server`) pour télécharger un vault du serveur dans un dossier
(menu ⚙ du vault, « Télécharger sur ce poste… »). Le bouton « ← Ce poste »
(barre du haut, ou écran de connexion) revient aux vaults locaux sans
relancer l'app. Dans le profil bureau, une fois connecté, le menu ⚙ d'un
vault local propose « Envoyer sur le serveur… ».

## Adresse du serveur

L'écran de connexion de l'app de bureau demande l'**adresse du serveur**
(`https://savoire.exemple.fr`, `http://192.168.1.10:5000`). Sans `http://`
ni `https://`, `https://` est supposé. Les adresses déjà utilisées sont
proposées (10 au plus) ; la dernière est choisie au lancement suivant. Chaque
serveur garde sa propre session : la personne reste connectée après un
redémarrage. En développement, l'adresse par défaut est celle du Vite
(`http://127.0.0.1:3002`), dont le proxy mène au backend.

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
Tests front : `tests/frontend/unit/desktop-tests` (`vitest run`).

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

- Passer d'un profil à l'autre recharge la page (pas l'app).
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
