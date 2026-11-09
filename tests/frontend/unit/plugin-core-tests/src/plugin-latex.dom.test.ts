// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Plugin LaTeX : apercu (HTML + MathML) et edition a plusieurs sur le texte
// partage du document.
import { describe, it, expect } from 'vitest'
import { InMemorySharedText } from '@savoire/plugin-runtime'
import type { FileContext } from '@savoire/plugin-api'
import plugin, { LATEX_TEMPLATE, createLatexView, latexEditorOf, renderLatex, stripComments, texToMathML } from '@savoire/plugin-latex'

describe('LaTeX : formules en MathML', () => {
  it('fractions, racines, indices, exposants, grecques', () => {
    const m = texToMathML('\\frac{a}{b} + \\sqrt{x^2} - \\alpha_i')
    expect(m).toContain('<mfrac><mrow><mi>a</mi></mrow><mrow><mi>b</mi></mrow></mfrac>')
    expect(m).toContain('<msqrt><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow></msqrt>')
    expect(m).toContain('<msub><mi>α</mi><mi>i</mi></msub>')
    expect(m).toContain('<annotation encoding="application/x-tex">')
  })

  it('somme avec bornes dessous/dessus en display, a cote en ligne', () => {
    expect(texToMathML('\\sum_{k=1}^{n} k', true)).toContain('<munderover><mo largeop="true" movablelimits="true">∑</mo>')
    expect(texToMathML('\\sum_{k=1}^{n} k', false)).toContain('<msubsup><mo largeop="true"')
    expect(texToMathML('x', true)).toContain('display="block"')
  })

  it('matrices, fonctions, texte, commande inconnue visible', () => {
    const m = texToMathML('\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}')
    expect(m).toContain('<mo fence="true">(</mo><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>2</mn></mtd></mtr><mtr><mtd><mn>3</mn></mtd>')
    expect(texToMathML('\\sin x')).toContain('<mi mathvariant="normal">sin</mi>')
    expect(texToMathML('\\text{si } x')).toContain('<mtext>si </mtext>')
    expect(texToMathML('\\foo')).toContain('<merror><mtext>\\foo</mtext></merror>')
  })
})

describe('LaTeX : apercu du document', () => {
  it('titre, sections numerotees, listes, mise en forme, formules, renvois', () => {
    const { html, unknown } = renderLatex(LATEX_TEMPLATE)
    expect(html).toContain('<h1 class="tex-title">Nouveau document</h1>')
    expect(html).toContain('<span class="tex-num">1</span>Introduction')
    expect(html).toContain('<span class="tex-num">1.1</span>Une liste')
    expect(html).toContain('<strong>gras</strong>')
    expect(html).toContain('<em>italique</em>')
    expect(html).toContain('<span class="tex-eqnum">(1)</span>')
    expect(html).toContain("L'équation&nbsp;(1) est")
    expect(html).toMatch(/<math[^>]*><semantics><mrow><mi>E<\/mi>/)
    expect(unknown).toEqual([])
  })

  it('commentaires, caracteres echappes, tableau, commande inconnue', () => {
    expect(stripComments('a % commentaire\nb 50\\% c')).toBe('a \nb 50\\% c')
    const { html, unknown } = renderLatex('\\begin{document}\nPrix : 50\\% -- \\monmacro{x}\n\n\\begin{tabular}{ll}\na & b \\\\\n\\hline\nc & d\n\\end{tabular}\n\\end{document}')
    expect(html).toContain('Prix : 50% –')
    expect(html).toContain('<table class="tex-table"><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')
    expect(unknown).toEqual(['\\monmacro'])
    // Le HTML du document est echappe.
    expect(renderLatex('<script>x</script>').html).toContain('&lt;script&gt;')
    expect(renderLatex('\\href{javascript:alert(1)}{lien}').html).not.toContain('javascript:')
  })
})

describe('LaTeX : edition a plusieurs', () => {
  it('deux membres ecrivent dans le meme document ; chacun voit l autre, apercu compris', async () => {
    const a = new InMemorySharedText('\\section{A}\n')
    const b = new InMemorySharedText('\\section{A}\n')
    InMemorySharedText.link(a, b)
    const mount = (text: InMemorySharedText) => {
      const el = document.createElement('div')
      document.body.appendChild(el)
      const view = createLatexView('doc.tex', { text, vaultId: 'v', path: 'doc.tex' } as unknown as FileContext, null)
      view.mount(el)
      return { el, view, cm: el.querySelector('.cm-content') as HTMLElement & { cmView?: { view: { dispatch(t: unknown): void; state: { doc: { length: number; toString(): string } } } } } }
    }
    const ma = mount(a)
    const mb = mount(b)
    // Frappe chez A (par l'editeur) : arrive dans le texte de B et dans l'editeur de B.
    const viewA = latexEditorOf(ma.el)!
    viewA.dispatch({ changes: { from: viewA.state.doc.length, insert: 'Bonjour $x^2$.\n' } })
    expect(b.toString()).toBe('\\section{A}\nBonjour $x^2$.\n')
    expect(mb.el.querySelector('.cm-content')!.textContent).toContain('Bonjour $x^2$.')
    // Ecriture de B en meme temps (debut du texte) : les deux convergent.
    b.insert(0, '% note\n')
    expect(a.toString()).toBe(b.toString())
    expect(ma.el.querySelector('.cm-content')!.textContent).toContain('% note')
    await new Promise(r => setTimeout(r, 200))
    expect(mb.el.querySelector('[data-testid="latex-preview"]')!.innerHTML).toContain('<msup><mi>x</mi><mn>2</mn></msup>')
    ma.view.destroy(); mb.view.destroy()
  })

  it('le type .tex est un CRDT, cree avec un exemple', async () => {
    const registered: { extension: string; collaborationMode?: string; create?: () => Promise<string> }[] = []
    await plugin.onload({ files: { register: (s: never) => registered.push(s) } } as never)
    expect(registered[0]).toMatchObject({ extension: 'tex', collaborationMode: 'crdt' })
    expect(await registered[0].create!()).toContain('\\begin{document}')
  })
})
