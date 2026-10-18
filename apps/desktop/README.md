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
(menu ⚙ du vault, « Télécharger sur ce poste… »). Le profil bureau revient au
lancement suivant.

## Prérequis

- Rust stable (1.77.2 au moins) : `rustup`, `cargo`.
- Linux : `libwebkit2gtk-4.1-dev`, `libssl-dev`, `librsvg2-dev`,
  `libayatana-appindicator3-dev`, `libxdo-dev`, `build-essential`.
  Autres systèmes : voir les prérequis Tauri 2.
- Les dépendances front du dépôt (`frontend/node_modules`), dont
  `@tauri-apps/cli` 2.

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
`apps/web/dist`), embarquée dans le binaire. Paquets produits (cibles
`deb` et `appimage`) : `src-tauri/target/release/bundle/`.

Tests Rust (chemins, liste des vaults, surveillance) : `cd src-tauri && cargo test`.
Tests front : `tests/frontend/unit/desktop-tests` (`vitest run`).

## Où sont les données

- **Les notes** : dans le dossier du vault, en clair. Ce que le texte ne porte
  pas (état CRDT, identifiants) est dans `<vault>/.savoire/`. Les écritures
  sont atomiques (fichier temporaire dans `.savoire/tmp/`, puis renommage).
- **La liste des vaults récents** : `recent-vaults.json` dans le dossier de
  configuration de l'application (Linux : `~/.config/org.savoire.desktop/`).
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
- Capacités (`src-tauri/capabilities/default.json`) : les commandes de vault
  et l'écoute d'événements, rien d'autre (ni dialogue, ni shell, ni http).
- « Supprimer » un vault local le retire de la liste ; le dossier n'est
  jamais effacé.

## Limites

- En build de production, la page est servie par Tauri : les appels `/api`
  relatifs ne joignent aucun serveur. Le profil serveur (et donc le
  téléchargement / l'envoi) ne marche aujourd'hui qu'en développement, via le
  proxy de Vite. Il faudra une adresse de serveur configurable.
- Pas encore de bouton pour revenir du profil serveur au profil bureau sans
  relancer l'app.
- Les liens symboliques ne sont pas suivis dans un vault.
- Une écriture atomique est vue par la surveillance comme une création
  (renommage), pas comme une modification.
- Un dossier déplacé ou renommé hors de l'app doit être rouvert
  (« Ouvrir un dossier… ») ; l'ancienne entrée apparaît « introuvable ».
