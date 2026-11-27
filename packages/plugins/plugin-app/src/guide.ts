// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le guide pour ecrire une application Savoire : rendu par l'outil MCP
// app_guide, et repris par la skill (skills/savoire-app/SKILL.md).

export const APP_GUIDE = `# Écrire une application Savoire

Une application est un fichier **.app** rangé dans un dossier du vault. Ce
dossier est le sien : elle y lit et y écrit ses fichiers (JSON, images...),
sans rien demander, et ne voit rien en dehors (sauf les bases, par requêtes).
Elle s'ouvre dans Savoire, en plein cadre ou en plein écran, et tourne dans
un cadre isolé : pas de réseau, pas d'accès à la page de Savoire.

## Fichiers

\`\`\`
Mon appli/
  Mon appli.app        ← le point d'entrée : du HTML (le corps de la page)
  main.js              ← modules ES (facultatif)
  lib/carte.js
  style.css
  donnees/plans.json   ← les données, en JSON
  images/logo.png
\`\`\`

- Le **.app** contient le HTML de la page (pas besoin de <html> ni <body>).
- Les fichiers **.js, .mjs, .css** du dossier (sous-dossiers compris)
  arrivent avec l'application. Dans le .app :
  \`<script type="module" src="main.js"></script>\` et
  \`<link rel="stylesheet" href="style.css">\` marchent.
- Entre modules : \`import { x } from './lib/carte.js'\` (chemins relatifs,
  avec l'extension) ou \`import { x } from 'app/lib/carte.js'\`.
- Une application à la racine du vault est en lecture seule : rangez-la dans
  un dossier.

## Bibliothèques

Savoire fournit React 19 : \`import React from 'react'\`,
\`import { createRoot } from 'react-dom/client'\`, \`react-dom\`,
\`react/jsx-runtime\`. Il n'y a pas d'étape de construction : pas de JSX,
écrivez \`const h = React.createElement\` puis \`h('div', props, ...enfants)\`.
Toute autre bibliothèque doit être un module ES dans le dossier de
l'application (aucun CDN à l'exécution : le réseau est fermé). Pour l'y
déposer sans recopier son code : l'outil MCP \`add_file\` (adresse https du
module, ou fichier du poste envoyé avec \`file_upload_url\`), par exemple dans
\`lib/\`, puis \`import x from './lib/x.js'\`.

## L'objet \`savoire\`

\`window.savoire\` existe avant votre code.

| Appel | Rôle |
|---|---|
| \`savoire.app\` | \`{ path, folder, name }\` de l'application |
| \`savoire.user\` | \`{ id, name }\` de la personne, ou null |
| \`savoire.readOnly\` | vrai si rien ne peut être écrit |
| \`savoire.files.list(dir?, { recursive })\` | \`[{ path, name, type: 'file' \\| 'folder' }]\`, chemins relatifs au dossier |
| \`savoire.files.read(path)\` / \`readJSON(path)\` | le texte d'un fichier, ou son JSON |
| \`savoire.files.write(path, text)\` / \`writeJSON(path, value)\` | crée ou remplace (dossiers créés au besoin) |
| \`savoire.files.writeBytes(path, octets)\` | range des octets (Uint8Array : une photo déposée) tels quels ; rend \`{ path }\` |
| \`savoire.files.remove(path)\` | à la corbeille |
| \`savoire.files.move(from, to)\` | déplace ou renomme |
| \`savoire.files.bytes(path)\` | un ArrayBuffer (image, son...) |
| \`savoire.files.bytes(path, { start, end })\` | seulement les octets [start, end[ : lecture partielle d'un gros fichier (fonds de carte PMTiles, vidéo) |
| \`savoire.files.size(path)\` | la taille du fichier, sans le lire |
| \`savoire.files.url(path)\` | une adresse blob: pour \`<img src>\`, \`<audio>\`, \`<video>\` |
| \`savoire.files.watch(cb)\` | \`cb([{ path, change: 'added' \\| 'removed' \\| 'changed' }])\` quand le dossier change (autres membres, IA) ; rend la fonction d'arrêt |
| \`savoire.query(q)\` / \`savoire.watch(q, cb)\` | requête sur une base du vault (comme un board) |
| \`savoire.createRow(base, titre, valeurs)\` / \`setProperty(...)\` | écrire dans une base (accord demandé une fois) |
| \`savoire.open(chemin)\` | ouvrir une note du vault |
| \`savoire.notify(message, type)\` | une notification brève ('info', 'success', 'warn', 'danger') |
| \`savoire.reload()\` | relance l'application (après un changement de thème, par exemple) ; \`location.reload()\` ne marche pas dans le cadre |

Tous les appels rendent des promesses. Les chemins sont relatifs au dossier
de l'application et ne peuvent pas en sortir.

## Données

- Un fichier JSON par chose qui vit seule (un plan, une fiche) vaut mieux
  qu'un gros fichier : deux personnes qui modifient deux fichiers ne se
  gênent pas.
- Les textes sont partagés : une écriture ne change que la différence, et
  fusionne avec les modifications des autres. Si deux personnes changent la
  même ligne au même moment, la dernière gagne.
- Relisez un fichier quand \`files.watch\` le signale.
- Les fichiers que l'application modifie (JSON) se créent en texte
  (\`app_write_file\`, ou \`savoire.files.write\`) ; \`add_file\` range un
  fichier tel quel, à ne pas réécrire (bibliothèque, image, police).

## Workers

\`new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))\`
marche (adresse blob:). Les workers n'ont pas de réseau non plus. Savoire les
compte, l'affiche, et peut les arrêter.

## Limites

- Pas de réseau : ni fetch vers Internet, ni image ou police distante.
- Messages de 8 Mo au plus vers Savoire ; 20 Mo de code au plus.
- Pas de navigation hors de l'application.

## Exemple minimal

\`\`\`html
<div id="root"></div>
<script type="module">
import React from 'react'
import { createRoot } from 'react-dom/client'
const h = React.createElement
function App() {
  const [n, setN] = React.useState(0)
  React.useEffect(() => { savoire.files.readJSON('donnees/n.json').then(d => setN(d.n), () => {}) }, [])
  const add = () => { setN(n + 1); savoire.files.writeJSON('donnees/n.json', { n: n + 1 }) }
  return h('button', { onClick: add }, 'Clics : ' + n)
}
createRoot(document.getElementById('root')).render(h(App))
</script>
\`\`\`

## Avec les outils MCP

1. \`app_create\` : crée le dossier, le .app et d'autres fichiers d'un coup.
2. \`app_write_file\` : crée ou remplace un fichier du dossier (module, style,
   JSON...). \`app_read\` : la liste des fichiers et le texte de l'un d'eux.
3. La personne ouvre le .app dans Savoire (↻ Relancer après un changement).
`
