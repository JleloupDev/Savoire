// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Documents existants : extracteurs Word, PowerPoint, Excel, OpenDocument,
// HTML, CSV, images ; contenu vu comme une note pour l'index ; apercu.
import { describe, it, expect } from 'vitest'
import { extractedToMarkdown } from '@savoire/plugin-api'
import {
  EXTRACTORS, extractCsv, extractDocx, extractHtml, extractImage, extractOpenDocument, extractPptx, extractXlsx, genericPreview,
} from '@savoire/plugin-documents'
import { createZip } from '../../../../../apps/web/src/zipArchive'

const enc = new TextEncoder()
async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const blob = createZip(Object.entries(files).map(([path, text]) => ({ path, bytes: enc.encode(text) })))
  return new Uint8Array(await blob.arrayBuffer())
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const p = (text: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

describe('documents existants : extracteurs', () => {
  it('Word : titre, sections par titre, metadonnees', async () => {
    const bytes = await zip({
      'word/document.xml': `<w:document ${W}><w:body>${p('Rapport annuel', 'Title')}${p('Intro &amp; contexte.')}${p('Budget', 'Heading1')}${p('Il reste 300 €.')}<w:p><w:r><w:t>A</w:t></w:r><w:r><w:tab/><w:t>B</w:t></w:r></w:p></w:body></w:document>`,
      'docProps/core.xml': '<cp:coreProperties><dc:creator>Jean</dc:creator><dcterms:created>2026-10-01T08:00:00Z</dcterms:created></cp:coreProperties>',
    })
    const c = await extractDocx(bytes)
    expect(c.title).toBe('Rapport annuel')
    expect(c.sections).toEqual([{ text: 'Intro & contexte.' }, { heading: 'Budget', text: 'Il reste 300 €.\nA\tB' }])
    expect(c.props).toMatchObject({ auteur: 'Jean', cree_le: '2026-10-01' })
    const md = extractedToMarkdown(c)
    expect(md).toContain('---\nauteur: "Jean"')
    expect(md).toContain('# Rapport annuel')
    expect(md).toContain('## Budget\n\nIl reste 300 €.')
  })

  it('PowerPoint : une section par diapositive, dans l ordre', async () => {
    const slide = (a: string, b: string) => `<p:sld><a:p><a:r><a:t>${a}</a:t></a:r></a:p><a:p><a:r><a:t>${b}</a:t></a:r></a:p></p:sld>`
    const c = await extractPptx(await zip({ 'ppt/slides/slide10.xml': slide('Fin', 'Merci'), 'ppt/slides/slide2.xml': slide('Plan', 'Point A') }))
    expect(c.sections.map(s => s.heading)).toEqual(['Diapositive 1 : Plan', 'Diapositive 2 : Fin'])
    expect(c.props).toMatchObject({ diapositives: 2 })
  })

  it('Excel : feuilles, chaines partagees, cases vides, booleens', async () => {
    const c = await extractXlsx(await zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Poste</t></si><si><t>Montant</t></si><si><r><t>Log</t></r><r><t>o</t></r></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1200</v></c><c r="D2" t="b"><v>1</v></c></row></sheetData></worksheet>',
    }))
    expect(c.sections[0].heading).toBe('Budget')
    expect(c.sections[0].rows).toEqual([['Poste', 'Montant'], ['Logo', '', '1200', 'VRAI']])
  })

  it('OpenDocument texte et classeur', async () => {
    const odt = await extractOpenDocument(await zip({
      'content.xml': '<office:document-content><office:body><office:text><text:h text:outline-level="1">Partie</text:h><text:p>Un <text:span>mot</text:span>.</text:p></office:text></office:body></office:document-content>',
      'meta.xml': '<office:meta><dc:title>Doc libre</dc:title><meta:initial-creator>Ana</meta:initial-creator></office:meta>',
    }))
    expect(odt).toMatchObject({ title: 'Doc libre', sections: [{ heading: 'Partie', text: 'Un mot.' }], props: { auteur: 'Ana' } })
    const ods = await extractOpenDocument(await zip({
      'content.xml': '<office:document-content><office:body><office:spreadsheet><table:table table:name="F1"><table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet></office:body></office:document-content>',
    }))
    expect(ods.sections).toEqual([{ heading: 'F1', text: 'a\tb', rows: [['a', 'b']] }])
  })

  it('HTML, CSV et images', async () => {
    const html = await extractHtml(enc.encode('<html><head><title>Site</title><script>x()</script><meta name="description" content="Desc"></head><body><p>Intro</p><h2>A propos</h2><p>Texte &eacute;l&#233;gant</p></body></html>'))
    expect(html.title).toBe('Site')
    expect(html.sections).toEqual([{ text: 'Intro' }, { heading: 'A propos', text: 'Texte élégant' }])
    const csv = await extractCsv(enc.encode('nom;prix\n"Pain; complet";2,40\nLait;1,10\n'))
    expect(csv.sections[0].rows).toEqual([['nom', 'prix'], ['Pain; complet', '2,40'], ['Lait', '1,10']])
    expect(csv.props).toEqual({ lignes: 2, colonnes: 2 })
    // PNG 3 x 2 (en-tete IHDR suffit).
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0])
    expect((await extractImage(png)).props).toEqual({ format: 'PNG', largeur: 3, hauteur: 2 })
  })

  it('un fichier abime donne une erreur lisible ; chaque extension a un extracteur', async () => {
    await expect(extractDocx(enc.encode('pas une archive'))).rejects.toThrow(/archive Office/)
    const exts = EXTRACTORS.flatMap(e => e.extensions)
    for (const e of ['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp', 'html', 'csv', 'txt', 'png', 'jpg', 'pdf']) expect(exts).toContain(e)
  })

  it('apercu : titre, proprietes, tableaux', () => {
    const el = genericPreview({ title: 'T', props: { auteur: 'Jean' }, sections: [{ heading: 'F', text: '', rows: [['a', 'b'], ['1', '2']] }, { text: 'l1\nl2' }] })
    expect(el.querySelector('h1')!.textContent).toBe('T')
    expect(el.querySelectorAll('td')).toHaveLength(4)
    expect([...el.querySelectorAll('p')].map(p => p.textContent)).toEqual(['l1', 'l2'])
  })
})

describe('documents existants : vues en lecture seule', () => {
  const tick = () => new Promise(r => setTimeout(r, 30))

  it('apercu d un CSV, et message clair sans octets', async () => {
    const { createPreviewView } = await import('@savoire/plugin-documents')
    const ctx = { vault: { readBinary: async () => enc.encode('a,b\n1,2\n') } }
    const el = document.createElement('div')
    createPreviewView('t.csv', ctx as never, null).mount(el)
    await tick()
    expect(el.querySelector('[data-testid="document-banner"]')!.textContent).toMatch(/lecture seule/)
    expect(el.querySelectorAll('td')).toHaveLength(4)
    const none = document.createElement('div')
    createPreviewView('t.csv', { vault: {} } as never, null).mount(none)
    await tick()
    expect(none.textContent).toMatch(/Aperçu indisponible/)
  })

  it('le plugin Office montre un vrai .docx en apercu, au lieu du formulaire de lien', async () => {
    const office = (await import('@savoire/plugin-office')).default
    const { ExtractorRegistryImpl } = await import('@savoire/plugin-runtime')
    const extractors = new ExtractorRegistryImpl()
    for (const e of EXTRACTORS) extractors.register(e)
    const bytes = await zip({ 'word/document.xml': `<w:document ${W}><w:body>${p('Bonjour du fichier')}</w:body></w:document>` })
    const types: { extension: string; open: (p: string, c: unknown) => { mount(el: HTMLElement): void } }[] = []
    await office.onload({ files: { register: (s: never) => types.push(s) }, extractors, icons: undefined } as never)
    const docx = types.find(t => t.extension === 'docx')!
    const el = document.createElement('div')
    docx.open('Rapport.docx', {
      vaultId: 'v', readOnly: false,
      vault: { readDocumentByPath: async () => 'PK binaire', readBinary: async () => bytes, resolveDocumentId: () => undefined },
    }).mount(el)
    await tick(); await tick()
    expect(el.querySelector('[data-testid="office-preview"]')!.textContent).toContain('Bonjour du fichier')
    expect(el.querySelector('[data-testid="office-url"]')).toBeNull()
  })
})
