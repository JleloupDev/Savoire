# plugin-board : Boards

Des mini applis en HTML, CSS et JavaScript, dans des fichiers `.board`, qui
interrogent et modifient les bases du vault. Pas de builder : on écrit le
code, l'aperçu se recharge quand on s'arrête de taper.

- **Fichier** : code à gauche (texte partagé, édité à plusieurs), aperçu à
  droite ; boutons Code / Côte à côte / Aperçu, ↻ Relancer.
- **Intégration** : `![[Tableau de bord.board]]` dans une note. La hauteur
  suit le contenu (40 à 1 600 px). ↻ relit le code du board.

## API (`window.savoire`)

| Appel | Rôle |
|---|---|
| `savoire.query(q)` | Une requête, une fois : `Promise<QueryResult>` |
| `savoire.watch(q, cb, onError?)` | La même, suivie en direct ; rend la fonction d'arrêt |
| `savoire.open(chemin)` | Ouvre une note (aussi : `<a data-open="dossier/note.md">`) |
| `savoire.setProperty(cible, clé, valeur)` | Écrit une propriété du frontmatter. `cible` : une ligne d'un résultat, ou un chemin de note |
| `savoire.createPage(base, titre, valeurs)` | Nouvelle ligne-page dans le dossier de la base |
| `savoire.readOnly` | Vrai quand le board ne peut rien écrire |

Une requête a la forme de `Query` (`packages/plugin-api/src/query.ts`) :
`where`, `sort`, `limit`, `cursor`, `groupBy`, `aggregate` (count, sum, mean,
min, max). `from` peut nommer une base : `"Projets"` ou `{ base: "Projets" }`
(nom, chemin ou id) ; Savoire ajoute son dossier de pages et son filtre de
source.

```html
<b id="total">…</b>
<script>
  savoire.watch({ from: 'Projets', aggregate: [{ op: 'sum', field: { prop: 'Prix' } }] },
    r => { document.getElementById('total').textContent = r.aggregates[0] })
</script>
```

Les couleurs et la police de l'appli arrivent en variables CSS
(`--text`, `--bg-surface`, `--border`, `--accent`, `--font-ui`...).

## Sécurité

Un vault est partagé : le code d'un membre s'exécute chez les autres.

- iframe `sandbox="allow-scripts"`, sans `allow-same-origin` : origine opaque,
  aucun accès à la page, aux cookies, au stockage ni au jeton de Savoire ;
- CSP `default-src 'none'` : aucun réseau (fetch, WebSocket, images et
  polices distantes) ;
- Savoire ne répond qu'aux messages de cette iframe, sur un canal tiré au
  sort, et seulement aux appels ci-dessus ; messages de 256 Kio au plus,
  50 requêtes suivies au plus ;
- écritures : jamais en lecture seule ; la première de chaque board demande
  l'accord de la personne qui le regarde (retenu pour la session) ;
  60 écritures par minute au plus ; valeurs simples seulement.

Limites connues :
- un board peut se recharger vers une adresse externe (aucune CSP ne
  l'interdit) : il ne voit que ce que la personne voit déjà, mais pourrait
  l'envoyer ainsi. À n'ouvrir que dans un vault de confiance ;
- les lignes légères d'une base ne s'écrivent pas encore depuis un board
  (seulement les lignes-pages) ;
