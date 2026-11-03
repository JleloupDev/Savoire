// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Contenu d'un board neuf : un exemple qui montre l'API.

export const BOARD_TEMPLATE = `<!-- Un board : HTML, CSS et JavaScript, isole du reste de Savoire.
     API : savoire.query(q), savoire.watch(q, cb), savoire.open(chemin),
           savoire.setProperty(ligne, "propriete", valeur),
           savoire.createPage("Base", "Titre", { propriete: valeur }).
     Requete : { from: "NomDeLaBase", where, sort, limit, aggregate }
     (meme forme que les requetes de Savoire). -->
<style>
  .kpi { display: flex; gap: 12px; }
  .card { flex: 1; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
  .card b { display: block; font-size: 28px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); }
</style>

<h2>Mon board</h2>
<p>Changez <code>BASE</code> dans le script pour le nom d'une de vos bases.</p>
<div class="kpi">
  <div class="card">Lignes <b id="count">…</b></div>
</div>
<table id="rows"></table>

<script>
  const BASE = 'Projets'
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  savoire.watch({ from: BASE, sort: [{ field: { doc: 'title' } }], limit: 20, aggregate: [{ op: 'count' }] }, r => {
    document.getElementById('count').textContent = r.aggregates ? r.aggregates[0] : r.total
    const rows = r.rows.map(row => '<tr><td><a href="#" data-open="' + esc(row.path) + '">' + esc(row.title) + '</a></td></tr>')
    document.getElementById('rows').innerHTML = rows.join('')
  }, err => { document.getElementById('count').textContent = '⚠ ' + err.message })
</script>
`
