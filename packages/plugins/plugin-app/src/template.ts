// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// L'exemple d'une application vide : React fourni par Savoire, des donnees
// en JSON dans le dossier de l'application, suivies en direct.
export const APP_TEMPLATE = `<div id="root"></div>
<script type="module">
import React from 'react'
import { createRoot } from 'react-dom/client'
const h = React.createElement
const FILE = 'donnees/compteur.json'

function App() {
  const [data, setData] = React.useState(null)
  React.useEffect(() => {
    const load = () => savoire.files.readJSON(FILE).then(setData, () => setData({ clics: 0 }))
    load()
    // Un autre membre (ou une IA) change le fichier : on le relit.
    return savoire.files.watch(changes => { if (changes.some(c => c.path === FILE)) load() })
  }, [])
  if (!data) return h('p', null, 'Chargement…')
  const add = async () => {
    const next = { clics: data.clics + 1 }
    setData(next)
    await savoire.files.writeJSON(FILE, next)
  }
  return h('main', { style: { padding: 24 } },
    h('h1', null, savoire.app.name),
    h('p', null, 'Clics : ', h('b', null, data.clics)),
    h('button', { onClick: add, disabled: savoire.readOnly }, '+1'),
    h('p', null, 'Les données sont dans ', h('code', null, FILE), ', partagées avec les membres du vault.'))
}

createRoot(document.getElementById('root')).render(h(App))
</script>
`
