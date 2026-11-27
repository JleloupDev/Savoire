# plugin-app : Applications

Un logiciel entier dans le vault : un fichier `.app` (HTML) et son dossier
(modules JavaScript, styles, données JSON, images). L'application s'ouvre en
plein cadre ou en plein écran, dans une iframe isolée, sans réseau.

- **Son dossier** : celui du `.app`, sous-dossiers compris. Elle y lit et y
  écrit sans demander, jamais en dehors. À la racine du vault : lecture seule.
- **React 19 fourni** (`react`, `react-dom`, `react-dom/client`,
  `react/jsx-runtime`), construit par `apps/web/vite.config.ts`
  (`appLibraries`, servi sous `/app-libs/`).
- **Modules** : les `.js`, `.mjs` et `.css` du dossier arrivent avec
  l'application ; le cadre en fait des adresses `blob:` nommées par une carte
  d'import (`app/<chemin>`), les imports relatifs sont réécrits.
- **Workers** permis (`worker-src blob:`), comptés dans la barre, avec une
  notification et un bouton pour les arrêter.
- **Fichiers de code et de données** (`.json`, `.geojson`, `.js`, `.mjs`,
  `.css`) : textes partagés avec leur éditeur, que l'IA modifie comme une
  note.

L'API `window.savoire` et les règles d'écriture : `src/guide.ts` (rendu par
l'outil MCP `app_guide`). Outils MCP : `app_guide`, `app_list`, `app_create`,
`app_read`, `app_write_file`. Skill pour Claude : `skills/savoire-app/`.

## Sécurité

- iframe `sandbox="allow-scripts"` sans `allow-same-origin` : origine opaque,
  rien de la page, des cookies, du stockage ni du jeton de Savoire ;
- politique du cadre (`APP_CSP`, `/app-frame.html`, protocole
  `savoire-board://localhost/app` au bureau) : scripts en ligne et `blob:`,
  workers `blob:`, `connect-src blob: data:` seulement : aucun réseau ;
- écritures : son dossier seulement, 600 par minute au plus ; les bases,
  comme un board (accord demandé une fois).

Limite connue (comme les boards) : le cadre peut se recharger vers une
adresse externe. À n'ouvrir que dans un vault de confiance.
