---
name: savoire-app
description: Écrire ou porter une application qui tourne dans Savoire (fichier .app, React fourni, données JSON du vault), par le connecteur MCP de Savoire. À utiliser quand la personne demande de créer, modifier ou adapter un logiciel, un outil ou un site pour qu'il tourne dans Savoire.
---

# Applications Savoire

Une application Savoire est un fichier `.app` (du HTML) rangé dans un dossier
du vault. Elle tourne dans un cadre isolé, sans réseau, lit et écrit les
fichiers de son dossier, et s'ouvre en plein écran. React 19 est fourni.

## Toujours commencer par

1. `list_vaults`, puis choisir le vault avec la personne.
2. **`app_guide`** : le guide à jour (fichiers, objet `savoire`, limites).
   Ne pas écrire de code avant de l'avoir lu.
3. `app_list` : une application existe peut-être déjà.

## Créer

- `app_create` avec `path` (un dossier, jamais la racine du vault), `html`
  (le contenu du `.app`) et `files` (modules `.js`, styles `.css`, données
  `.json`).
- Ensuite, `app_write_file` pour chaque fichier en plus ou à corriger
  (`content` pour tout le texte, `find` + `replace` pour un passage).
- `app_read` pour relire la liste des fichiers ou le texte de l'un d'eux.
- Dire à la personne d'ouvrir le `.app` dans Savoire, et de cliquer sur
  « ↻ Relancer » après un changement.

## Règles d'écriture

- **Pas d'étape de construction.** Pas de JSX, pas de TypeScript, pas de
  `npm`. Modules ES écrits à la main : `const h = React.createElement`.
- Imports : `react`, `react-dom/client`, `react-dom`, `react/jsx-runtime`
  (fournis) ; entre fichiers, chemins relatifs **avec l'extension**
  (`./lib/arbre.js`).
- **Réseau fermé** : ni `fetch` vers Internet, ni CDN, ni police ou image
  distante. Une bibliothèque en plus doit être un module ES déposé dans le
  dossier de l'application, **sans recopier son code** : `add_file` avec
  `url` (adresse https du module, avec l'accord de la personne sur la
  source), ou, si vous avez un terminal, `file_upload_url` puis
  `curl -T fichier <adresse>` puis `add_file` avec `upload`.
- Photos, sons, données lourdes : même chemin (`add_file`).
- Données : un fichier JSON par chose (un plan, une fiche) plutôt qu'un gros
  fichier ; relire un fichier quand `savoire.files.watch` le signale.
- Les images et sons du dossier s'affichent par `await savoire.files.url(chemin)`.
- `app_write_file` : 2 Mo au plus, pour le code que vous écrivez ; un
  fichier existant (bibliothèque, image) passe par `add_file` (100 Mo).
- Lire un gros PDF : `read_note` avec `pages` (ex. `120-135`).

## Porter une application existante (Vite, React)

| Dans l'application d'origine | Dans Savoire |
|---|---|
| `fetch('/__…')` vers le serveur de dev, `writeFileSync` | `savoire.files.write` / `writeJSON` |
| `import.meta.glob('…/*.json')` | `savoire.files.list(dossier, { recursive: true })` puis `readJSON` |
| fichiers de `public/` (`staticFile`, `/geo/…`) | copiés dans le dossier, lus par `files.read` ou `files.url` |
| corbeille maison, renommages | `savoire.files.remove` (corbeille du vault), `files.move` |
| mot de passe, comptes | rien : les droits du vault s'appliquent |
| JSX, TypeScript | `React.createElement`, JavaScript |
| bibliothèques npm | modules ES dans le dossier (ou à demander à la personne) |

Procéder écran par écran, en commençant par le plus simple, et faire essayer
à la personne entre deux étapes.

## Ce qu'une application ne peut pas faire

Aller sur Internet, lire hors de son dossier (sauf les bases, par
`savoire.query`), naviguer hors d'elle-même, fabriquer une vidéo côté
serveur. Le dire franchement si la demande en dépend.
