# Bibliothèques communes des plugins

Un plugin publié hors du dépôt (store externe, à venir) n'embarque pas sa propre
copie de React ou de CodeMirror. Savoire les lui fournit, dans **sa** version.

## Liste

`@savoire/plugin-api`, `react`, `react/jsx-runtime`, `react-dom`,
`react-dom/client`, `@codemirror/state`, `@codemirror/view`,
`@codemirror/language`, `@codemirror/commands`.

Yjs n'y est pas : un plugin passe par l'API CRDT de Savoire (texte, arbre,
carte partagés), jamais par la bibliothèque.

Une bibliothèque hors liste est refusée au chargement, avec un message clair :
le plugin doit l'embarquer.

## Construire un plugin

- Format **CommonJS** : `module.exports = { manifest, onload, onunload }`.
- Les bibliothèques communes sont **externes** : `require('react')`.
  - esbuild : `--format=cjs --external:react --external:@codemirror/*`.
  - Vite / Rollup : `build.lib.formats: ['cjs']`, `rollupOptions.external`.
- Facultatif : `manifest.libraries` liste ce que le plugin utilise.

## Côté Savoire

- `SharedLibraryRegistry` (plugin-runtime) : l'hôte enregistre chaque
  bibliothèque avec une fonction qui la charge. Rien n'est chargé d'avance.
- `PluginLoader` repère les `require('…')` du paquet, charge ces
  bibliothèques, puis exécute le plugin avec un `require` limité à la liste.
- `api.libraries` donne aussi la liste à un plugin déjà chargé.

## Limites

- Les `require` doivent être écrits en clair (`require('react')`), pas calculés.
- L'appli de bureau interdit le code chargé depuis un `blob:` (sa CSP) : les
  plugins externes n'y tournent pas encore.
- Versions : un plugin reçoit la version de Savoire. Le champ `apiVersion` du
  manifeste, et les mises à jour, restent à faire (gestion des droits, plus tard).
