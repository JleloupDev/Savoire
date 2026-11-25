// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Export PowerPoint (.pptx) d'une presentation, sans dependance : le format
// Office Open XML ecrit a la main, dans une archive zip (plugin-api).
//
// Chaque diapositive est lue dans son rendu (Slides.ts) : le titre, les
// paragraphes et les listes deviennent du texte modifiable dans PowerPoint ;
// les images, des images ; les notes du presentateur, les notes de la
// diapositive. Ce qui n'a pas d'equivalent (une animation, un board) laisse
// une ligne qui le nomme.
//
// Fichier minimal mais complet : un masque, une disposition vide, un theme,
// un masque des notes. Ouvert par PowerPoint, Keynote, LibreOffice et Google
// Slides.
import { createZip, type SlideDecor, type SlideRatio, type SlideTransition, type ZipEntry } from '@savoire/plugin-api'
import type { SlideColors } from './Slides'

// ── Modele ──────────────────────────────────────────────────────────────

export interface PptxRun {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  /** Saut de ligne dans le paragraphe (le texte est ignore). */
  br?: boolean
}

export interface PptxParagraph {
  runs: PptxRun[]
  /** Profondeur dans une liste (0 : premier niveau). */
  level?: number
  bullet?: 'none' | 'bullet' | 'number'
  /** Titre de niveau 3 a 6 dans le corps : plus grand, en gras. */
  heading?: boolean
  quote?: boolean
  mono?: boolean
}

export interface PptxPicture {
  bytes: Uint8Array
  ext: 'png' | 'jpeg' | 'gif'
  /** Taille naturelle, pour garder les proportions. */
  width: number
  height: number
}

export interface PptxSlide {
  title: PptxRun[]
  paragraphs: PptxParagraph[]
  pictures: PptxPicture[]
  notes: string
  /** Diapositive de titre : texte centre. */
  cover: boolean
  /** Transition a l'entree de la diapositive. */
  transition?: SlideTransition
  decor?: SlideDecor
  /** Couleur de fond propre a la diapositive (#rrggbb). */
  background?: string
  /** Image de fond : toute la diapositive ou une moitie. */
  image?: { picture: PptxPicture; side: 'plein' | 'gauche' | 'droite' }
}

export interface PptxDeck {
  title: string
  ratio: SlideRatio
  colors: SlideColors
  slides: PptxSlide[]
}

// ── XML ─────────────────────────────────────────────────────────────────

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`

/** Texte sur dans un document XML (caracteres interdits retires). */
export function xmlText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const hex = (color: string): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (m) return m[1]!.toUpperCase()
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color.trim())
  return short ? `${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase() : '000000'
}

/** Taille d'une diapositive, en EMU (914 400 par pouce). */
export function slideSizeEmu(ratio: SlideRatio): { cx: number; cy: number } {
  return ratio === '4:3' ? { cx: 9144000, cy: 6858000 } : { cx: 12192000, cy: 6858000 }
}

const fill = (color: string) => `<a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill>`

function runXml(r: PptxRun, size: number, color: string, extra: { bold?: boolean; italic?: boolean; mono?: boolean } = {}): string {
  if (r.br) return '<a:br/>'
  const b = r.bold || extra.bold ? ' b="1"' : ''
  const i = r.italic || extra.italic ? ' i="1"' : ''
  const font = r.code || extra.mono ? '<a:latin typeface="Consolas"/><a:cs typeface="Consolas"/>' : ''
  return `<a:r><a:rPr lang="fr-FR" sz="${size}"${b}${i} dirty="0">${fill(color)}${font}</a:rPr><a:t>${xmlText(r.text)}</a:t></a:r>`
}

const BODY_SIZES = [2400, 2000, 1800, 1600]

interface ParagraphStyle {
  size?: number
  color?: string
  bold?: boolean
  /** Espace avant le paragraphe (6 pt). Defaut : oui, sauf le code. */
  spacing?: boolean
}

function paragraphXml(p: PptxParagraph, colors: SlideColors, align: 'l' | 'ctr', style: ParagraphStyle = {}): string {
  const level = Math.max(0, Math.min(3, p.level ?? 0))
  const size = style.size ?? (p.mono ? 1400 : p.heading ? 2800 : BODY_SIZES[level]!)
  const color = style.color ?? (p.quote ? colors.muted : p.heading ? colors.heading : colors.text)
  const indent = 342900
  const marL = p.bullet && p.bullet !== 'none' ? indent * (level + 1) : 0
  const bullet = p.bullet === 'bullet'
    ? `<a:buClr><a:srgbClr val="${hex(colors.accent)}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/>`
    : p.bullet === 'number' ? `<a:buClr><a:srgbClr val="${hex(colors.accent)}"/></a:buClr><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>` : '<a:buNone/>'
  const spacing = (style.spacing ?? !p.mono) ? '<a:spcBef><a:spcPts val="600"/></a:spcBef>' : ''
  const pPr = `<a:pPr marL="${marL}" indent="${marL ? -indent : 0}" algn="${align}"${marL ? ` lvl="${level}"` : ''}>${spacing}${bullet}</a:pPr>`
  const runs = p.runs.map(r => runXml(r, size, color, { bold: style.bold || p.heading, italic: p.quote, mono: p.mono })).join('')
  return `<a:p>${pPr}${runs}<a:endParaRPr lang="fr-FR" sz="${size}" dirty="0"/></a:p>`
}

function textBox(id: number, name: string, x: number, y: number, cx: number, cy: number, paragraphs: string, anchor: 't' | 'ctr' | 'b' = 't'): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlText(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
}

function pictureXml(id: number, rid: string, x: number, y: number, cx: number, cy: number, crop = ''): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Image ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${rid}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
}

/** Place les images dans une zone, l'une sous l'autre, proportions gardees. */
function layoutPictures(pics: PptxPicture[], x: number, y: number, cx: number, cy: number): { x: number; y: number; cx: number; cy: number }[] {
  if (!pics.length) return []
  const gap = 152400
  const each = (cy - gap * (pics.length - 1)) / pics.length
  return pics.map((p, i) => {
    const ratio = p.width > 0 && p.height > 0 ? p.width / p.height : 4 / 3
    let w = cx, h = cx / ratio
    if (h > each) { h = each; w = each * ratio }
    return { x: x + (cx - w) / 2, y: y + i * (each + gap) + (each - h) / 2, cx: w, cy: h }
  })
}

/** Recadre une image pour couvrir une zone sans la deformer (comme object-fit: cover). */
function coverCrop(p: PptxPicture, cx: number, cy: number): string {
  if (!(p.width > 0 && p.height > 0 && cx > 0 && cy > 0)) return ''
  const pic = p.width / p.height, box = cx / cy
  if (Math.abs(pic - box) < 0.001) return ''
  if (pic > box) {
    const cut = Math.round((1 - box / pic) / 2 * 100000)
    return `<a:srcRect l="${cut}" r="${cut}"/>`
  }
  const cut = Math.round((1 - pic / box) / 2 * 100000)
  return `<a:srcRect t="${cut}" b="${cut}"/>`
}

/** Melange deux couleurs #rrggbb (`t` : part de `a`). */
function mix(a: string, b: string, t: number): string {
  const ca = hex(a), cb = hex(b)
  const ch = (s: string, i: number) => parseInt(s.slice(i, i + 2), 16)
  return [0, 2, 4].map(i => Math.round(ch(ca, i) * t + ch(cb, i) * (1 - t)).toString(16).padStart(2, '0')).join('')
}

function shapeXml(id: number, name: string, geom: 'rect' | 'ellipse' | 'roundRect', x: number, y: number, cx: number, cy: number, fillXml: string, lineXml = '<a:ln><a:noFill/></a:ln>'): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlText(name)}"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm><a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${fillXml}${lineXml}</p:spPr></p:sp>`
}

const alphaFill = (color: string, alpha: number) => `<a:solidFill><a:srgbClr val="${hex(color)}"><a:alpha val="${Math.round(alpha * 100000)}"/></a:srgbClr></a:solidFill>`

const TRANSITION_XML: Record<SlideTransition, string> = {
  aucune: '',
  fondu: '<p:fade/>',
  glissement: '<p:push dir="l"/>',
  zoom: '<p:zoom/>',
  // Pas de cube dans le format de base : une poussee, la plus proche.
  cube: '<p:push dir="l"/>',
}

const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'

function slideXml(s: PptxSlide, deck: PptxDeck, picRids: string[], imageRid?: string): string {
  const { cx: W, cy: H } = slideSizeEmu(deck.ratio)
  const px = W / (deck.ratio === '4:3' ? 1024 : 1280)
  const m = 457200 * 1.1
  const c = s.background ? { ...deck.colors, bg: s.background } : deck.colors
  const shapes: string[] = []
  let id = 2
  // Decor, sous le reste.
  if (s.decor === 'bande') {
    shapes.push(shapeXml(id++, 'Bande', 'rect', 0, 0, W, 14 * px, fill(c.accent)))
    shapes.push(shapeXml(id++, 'Filet', 'roundRect', 72 * px, H - 58 * px, 120 * px, 4 * px, alphaFill(c.accent, 0.55)))
  } else if (s.decor === 'formes') {
    shapes.push(shapeXml(id++, 'Forme', 'ellipse', W - 370 * px, -230 * px, 560 * px, 560 * px, alphaFill(c.accent, 0.16)))
    shapes.push(shapeXml(id++, 'Anneau', 'ellipse', -102 * px, H - 132 * px, 264 * px, 264 * px, '<a:noFill/>', `<a:ln w="${Math.round(36 * px)}">${alphaFill(c.heading, 0.12)}</a:ln>`))
  }
  // Image de fond, et la zone laissee au texte.
  let left = m, right = W - m
  if (s.image && imageRid) {
    const side = s.image.side
    const ix = side === 'droite' ? W / 2 : 0
    const iw = side === 'plein' ? W : W / 2
    shapes.push(pictureXml(id++, imageRid, ix, 0, iw, H, coverCrop(s.image.picture, iw, H)))
    if (side === 'plein') shapes.push(shapeXml(id++, 'Voile', 'rect', 0, 0, W, H, alphaFill(c.bg, 0.45)))
    if (side === 'gauche') left = W / 2 + 56 * px
    if (side === 'droite') right = W / 2 - 56 * px
  }
  const tw = right - left
  const hasText = s.paragraphs.length > 0
  if (s.cover) {
    if (s.title.length) {
      const title = paragraphXml({ runs: s.title }, c, 'ctr', { size: 4800, color: c.heading, bold: true, spacing: false })
      shapes.push(textBox(id++, 'Titre', left, H * 0.26, tw, H * 0.22, title, 'b'))
    }
    const below = s.paragraphs.map(p => paragraphXml(p, c, 'ctr')).join('')
    if (below) shapes.push(textBox(id++, 'Texte', left, H * 0.52, tw, s.pictures.length ? H * 0.16 : H * 0.36, below))
    layoutPictures(s.pictures, left, s.pictures.length && !below ? H * 0.52 : H * 0.7, tw, H * 0.24).forEach((r, i) => shapes.push(pictureXml(id++, picRids[i]!, r.x, r.y, r.cx, r.cy)))
  } else {
    let top = m * 0.8
    if (s.title.length) {
      const title = paragraphXml({ runs: s.title }, c, 'l', { size: 3600, color: c.heading, bold: true, spacing: false })
      shapes.push(textBox(id++, 'Titre', left, top, tw, 914400, title, 'b'))
      top += 914400 + 182880
    }
    const bodyH = H - top - m
    const textW = s.pictures.length && hasText ? tw * 0.56 : tw
    if (hasText) shapes.push(textBox(id++, 'Texte', left, top, textW, bodyH, s.paragraphs.map(p => paragraphXml(p, c, 'l')).join('')))
    const pxl = hasText ? left + textW + 228600 : left
    const pw = hasText ? right - pxl : tw
    layoutPictures(s.pictures, pxl, top, pw, bodyH).forEach((r, i) => shapes.push(pictureXml(id++, picRids[i]!, r.x, r.y, r.cx, r.cy)))
  }
  const bg = s.decor === 'dégradé'
    ? `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="${mix(c.accent, c.bg, 0.2)}"/></a:gs><a:gs pos="55000"><a:srgbClr val="${hex(c.bg)}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${mix(c.heading, c.bg, 0.12)}"/></a:gs></a:gsLst><a:lin ang="8100000" scaled="0"/></a:gradFill>`
    : fill(c.bg)
  const transition = TRANSITION_XML[s.transition ?? 'aucune']
  return `${XML_HEAD}<p:sld ${NS}><p:cSld><p:bg><p:bgPr>${bg}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>`
    + (transition ? `<p:transition spd="med">${transition}</p:transition>` : '')
    + '</p:sld>'
}

function notesXml(notes: string): string {
  const paras = notes.split(/\n/).map(l => `<a:p><a:r><a:rPr lang="fr-FR" dirty="0"/><a:t>${xmlText(l)}</a:t></a:r></a:p>`).join('') || '<a:p><a:endParaRPr lang="fr-FR" dirty="0"/></a:p>'
  return `${XML_HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Image de la diapositive"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
}

const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

function themeXml(c: SlideColors, name: string): string {
  const solid = (v: string) => `<a:solidFill><a:schemeClr val="${v}"/></a:solidFill>`
  const line = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${solid('phClr')}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`
  const font = (latin: string) => `<a:latin typeface="${latin}"/><a:ea typeface=""/><a:cs typeface=""/>`
  return `${XML_HEAD}<a:theme xmlns:a="${NS_A}" name="${xmlText(name)}"><a:themeElements>`
    + `<a:clrScheme name="Savoire"><a:dk1><a:srgbClr val="${hex(c.text)}"/></a:dk1><a:lt1><a:srgbClr val="${hex(c.bg)}"/></a:lt1>`
    + `<a:dk2><a:srgbClr val="${hex(c.heading)}"/></a:dk2><a:lt2><a:srgbClr val="${hex(c.surface)}"/></a:lt2>`
    + `<a:accent1><a:srgbClr val="${hex(c.accent)}"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>`
    + '<a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
    + `<a:hlink><a:srgbClr val="${hex(c.accent)}"/></a:hlink><a:folHlink><a:srgbClr val="${hex(c.muted)}"/></a:folHlink></a:clrScheme>`
    + `<a:fontScheme name="Savoire"><a:majorFont>${font('Calibri')}</a:majorFont><a:minorFont>${font('Calibri')}</a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="Savoire"><a:fillStyleLst>${solid('phClr')}${solid('phClr')}${solid('phClr')}</a:fillStyleLst>`
    + `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>`
    + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    + `<a:bgFillStyleLst>${solid('phClr')}${solid('phClr')}${solid('phClr')}</a:bgFillStyleLst></a:fmtScheme>`
    + '</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
}

const rels = (items: { id: string; type: string; target: string }[]) =>
  `${XML_HEAD}<Relationships xmlns="${PKG_REL}">${items.map(r => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('')}</Relationships>`

const enc = new TextEncoder()

/** Les fichiers de l'archive .pptx. */
export function pptxEntries(deck: PptxDeck, now = new Date()): ZipEntry[] {
  const files: { path: string; content: string | Uint8Array }[] = []
  const put = (path: string, content: string | Uint8Array) => files.push({ path, content })
  const { cx, cy } = slideSizeEmu(deck.ratio)
  const n = deck.slides.length
  const exts = new Set<string>()

  deck.slides.forEach((s, i) => {
    const num = i + 1
    const picRids: string[] = []
    const slideRels = [
      { id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: `${REL}/notesSlide`, target: `../notesSlides/notesSlide${num}.xml` },
    ]
    s.pictures.forEach((p, j) => {
      const name = `image${num}_${j + 1}.${p.ext}`
      exts.add(p.ext)
      put(`ppt/media/${name}`, p.bytes)
      const rid = `rId${j + 3}`
      picRids.push(rid)
      slideRels.push({ id: rid, type: `${REL}/image`, target: `../media/${name}` })
    })
    let imageRid: string | undefined
    if (s.image) {
      const p = s.image.picture
      const name = `fond${num}.${p.ext}`
      exts.add(p.ext)
      put(`ppt/media/${name}`, p.bytes)
      imageRid = `rId${s.pictures.length + 3}`
      slideRels.push({ id: imageRid, type: `${REL}/image`, target: `../media/${name}` })
    }
    put(`ppt/slides/slide${num}.xml`, slideXml(s, deck, picRids, imageRid))
    put(`ppt/slides/_rels/slide${num}.xml.rels`, rels(slideRels))
    put(`ppt/notesSlides/notesSlide${num}.xml`, notesXml(s.notes))
    put(`ppt/notesSlides/_rels/notesSlide${num}.xml.rels`, rels([
      { id: 'rId1', type: `${REL}/notesMaster`, target: '../notesMasters/notesMaster1.xml' },
      { id: 'rId2', type: `${REL}/slide`, target: `../slides/slide${num}.xml` },
    ]))
  })

  const mime: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif' }
  const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="${type}"/>`
  put('[Content_Types].xml', `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + [...exts].map(e => `<Default Extension="${e}" ContentType="${mime[e]}"/>`).join('')
    + override('/ppt/presentation.xml', `${CT}.presentationml.presentation.main+xml`)
    + override('/ppt/slideMasters/slideMaster1.xml', `${CT}.presentationml.slideMaster+xml`)
    + override('/ppt/slideLayouts/slideLayout1.xml', `${CT}.presentationml.slideLayout+xml`)
    + override('/ppt/notesMasters/notesMaster1.xml', `${CT}.presentationml.notesMaster+xml`)
    + override('/ppt/theme/theme1.xml', `${CT}.theme+xml`)
    + override('/ppt/theme/theme2.xml', `${CT}.theme+xml`)
    + override('/ppt/presProps.xml', `${CT}.presentationml.presProps+xml`)
    + override('/ppt/viewProps.xml', `${CT}.presentationml.viewProps+xml`)
    + override('/ppt/tableStyles.xml', `${CT}.presentationml.tableStyles+xml`)
    + Array.from({ length: n }, (_, i) => override(`/ppt/slides/slide${i + 1}.xml`, `${CT}.presentationml.slide+xml`)
      + override(`/ppt/notesSlides/notesSlide${i + 1}.xml`, `${CT}.presentationml.notesSlide+xml`)).join('')
    + override('/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml')
    + override('/docProps/app.xml', `${CT}.extended-properties+xml`)
    + '</Types>')

  put('_rels/.rels', rels([
    { id: 'rId1', type: `${REL}/officeDocument`, target: 'ppt/presentation.xml' },
    { id: 'rId2', type: `${PKG_REL}/metadata/core-properties`, target: 'docProps/core.xml' },
    { id: 'rId3', type: `${REL}/extended-properties`, target: 'docProps/app.xml' },
  ]))
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  put('docProps/core.xml', `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${xmlText(deck.title)}</dc:title><dc:creator>Savoire</dc:creator>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`)
  put('docProps/app.xml', `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Savoire</Application><Slides>${n}</Slides><Notes>${n}</Notes></Properties>`)

  put('ppt/presentation.xml', `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>'
    + `<p:sldIdLst>${Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/>`
    + '<p:defaultTextStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>')
  put('ppt/_rels/presentation.xml.rels', rels([
    { id: 'rId1', type: `${REL}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: `${REL}/notesMaster`, target: 'notesMasters/notesMaster1.xml' },
    { id: 'rId3', type: `${REL}/presProps`, target: 'presProps.xml' },
    { id: 'rId4', type: `${REL}/viewProps`, target: 'viewProps.xml' },
    { id: 'rId5', type: `${REL}/theme`, target: 'theme/theme1.xml' },
    { id: 'rId6', type: `${REL}/tableStyles`, target: 'tableStyles.xml' },
    ...Array.from({ length: n }, (_, i) => ({ id: `rId${10 + i}`, type: `${REL}/slide`, target: `slides/slide${i + 1}.xml` })),
  ]))
  put('ppt/presProps.xml', `${XML_HEAD}<p:presentationPr ${NS}/>`)
  put('ppt/viewProps.xml', `${XML_HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="80000"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`)
  put('ppt/tableStyles.xml', `${XML_HEAD}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`)

  put('ppt/slideMasters/slideMaster1.xml', `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld>${CLR_MAP}`
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>')
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([
    { id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: `${REL}/theme`, target: '../theme/theme1.xml' },
  ]))
  put('ppt/slideLayouts/slideLayout1.xml', `${XML_HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Vide"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)
  put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([{ id: 'rId1', type: `${REL}/slideMaster`, target: '../slideMasters/slideMaster1.xml' }]))
  put('ppt/theme/theme1.xml', themeXml(deck.colors, 'Savoire'))
  put('ppt/theme/theme2.xml', themeXml({ ...deck.colors, bg: '#ffffff', text: '#000000', heading: '#000000', surface: '#eeeeee' }, 'Notes'))
  put('ppt/notesMasters/notesMaster1.xml', `${XML_HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Image de la diapositive"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>'
    + '<p:spPr><a:xfrm><a:off x="381000" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp>'
    + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>'
    + '<p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
    + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="fr-FR"/></a:p></p:txBody></p:sp>'
    + `</p:spTree></p:cSld>${CLR_MAP}<p:notesStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`)
  put('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([{ id: 'rId1', type: `${REL}/theme`, target: '../theme/theme2.xml' }]))

  // [Content_Types].xml en tete de l'archive, comme les suites bureautiques.
  files.sort((a, b) => (a.path === '[Content_Types].xml' ? -1 : b.path === '[Content_Types].xml' ? 1 : 0))
  return files.map(f => ({ path: f.path, bytes: typeof f.content === 'string' ? enc.encode(f.content) : f.content, date: now }))
}

/** L'archive .pptx. */
export function buildPptx(deck: PptxDeck, now = new Date()): Blob {
  const blob = createZip(pptxEntries(deck, now))
  return new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
}

// ── Lecture du rendu ────────────────────────────────────────────────────

const INLINE_SKIP = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'svg', 'SVG', 'IFRAME'])

/** Les morceaux de texte d'un element, avec gras, italique et code. */
export function runsOf(el: Node, style: { bold?: boolean; italic?: boolean; code?: boolean } = {}): PptxRun[] {
  const out: PptxRun[] = []
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ')
      if (text) out.push({ text, ...style })
      continue
    }
    if (node.nodeType !== 1) continue
    const e = node as HTMLElement
    const tag = e.tagName.toUpperCase()
    if (INLINE_SKIP.has(e.tagName) || tag === 'UL' || tag === 'OL') continue
    if (tag === 'BR') { out.push({ text: '', br: true }); continue }
    if (tag === 'INPUT') { if ((e as HTMLInputElement).type === 'checkbox') out.push({ text: (e as HTMLInputElement).checked ? '☑ ' : '☐ ', ...style }); continue }
    if (tag === 'IMG') continue
    out.push(...runsOf(e, {
      bold: style.bold || tag === 'STRONG' || tag === 'B',
      italic: style.italic || tag === 'EM' || tag === 'I',
      code: style.code || tag === 'CODE' || tag === 'KBD',
    }))
  }
  return out
}

function trimRuns(runs: PptxRun[]): PptxRun[] {
  const r = runs.map(x => ({ ...x }))
  while (r.length && !r[0]!.br && !r[0]!.text.trim()) r.shift()
  while (r.length && !r[r.length - 1]!.br && !r[r.length - 1]!.text.trim()) r.pop()
  if (r[0] && !r[0].br) r[0].text = r[0].text.replace(/^\s+/, '')
  const last = r[r.length - 1]
  if (last && !last.br) last.text = last.text.replace(/\s+$/, '')
  return r
}

export interface ReadSlide {
  title: PptxRun[]
  paragraphs: PptxParagraph[]
  /** Images a recuperer (element, dans l'ordre). */
  images: HTMLImageElement[]
}

/** Ce que l'export garde d'une diapositive rendue (.plume-slide-body). */
export function readSlideBody(body: HTMLElement): ReadSlide {
  const out: ReadSlide = { title: [], paragraphs: [], images: [] }
  let titled = false
  const placeholder = (label: string) => out.paragraphs.push({ runs: [{ text: `[${label}]`, italic: true }], quote: true })
  const visit = (el: HTMLElement, depth: number, ordered: boolean | null) => {
    const tag = el.tagName.toUpperCase()
    // Les commandes d'un rendu (boutons, barre de lecture...) ne sont pas du contenu.
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || el.getAttribute('aria-hidden') === 'true') return
    // Un rendu de plugin qui se nomme lui-meme pour l'export (une animation...).
    const label = el.dataset?.exportLabel
    if (label) { placeholder(label); return }
    if (el.classList?.contains('plume-plugin-render')) {
      // Un bloc de code garde son code, sans sa barre ; un cadre devient son nom.
      const pre = el.querySelector('pre')
      if (pre) { visit(pre, depth, ordered); return }
      const frame = el.querySelector('iframe')
      if (frame) { placeholder(frame.getAttribute('title') || 'Contenu intégré'); return }
    }
    if (tag === 'IMG') { out.images.push(el as HTMLImageElement); return }
    if (/^H[1-6]$/.test(tag)) {
      const runs = trimRuns(runsOf(el))
      if (!runs.length) return
      if (!titled && (tag === 'H1' || tag === 'H2')) { out.title = runs; titled = true; return }
      out.paragraphs.push({ runs, heading: true })
      return
    }
    if (tag === 'P') {
      for (const img of Array.from(el.querySelectorAll('img'))) out.images.push(img)
      const runs = trimRuns(runsOf(el))
      if (runs.length) out.paragraphs.push({ runs })
      return
    }
    if (tag === 'UL' || tag === 'OL') {
      for (const li of Array.from(el.children)) if (li.tagName.toUpperCase() === 'LI') visit(li as HTMLElement, depth, tag === 'OL')
      return
    }
    if (tag === 'LI') {
      const own = trimRuns(runsOf(el))
      if (own.length) out.paragraphs.push({ runs: own, level: depth, bullet: ordered ? 'number' : 'bullet' })
      for (const img of Array.from(el.querySelectorAll(':scope > img, :scope > p > img'))) out.images.push(img as HTMLImageElement)
      for (const c of Array.from(el.children)) {
        const t = c.tagName.toUpperCase()
        if (t === 'UL' || t === 'OL') visit(c as HTMLElement, depth + 1, t === 'OL')
        else if (t === 'P') {
          const runs = trimRuns(runsOf(c))
          if (runs.length && !own.length) out.paragraphs.push({ runs, level: depth, bullet: ordered ? 'number' : 'bullet' })
        }
      }
      return
    }
    if (tag === 'PRE') {
      for (const line of (el.textContent ?? '').replace(/\n$/, '').split('\n')) out.paragraphs.push({ runs: [{ text: line || ' ' }], mono: true })
      return
    }
    if (tag === 'BLOCKQUOTE') {
      for (const c of Array.from(el.children)) {
        const runs = trimRuns(runsOf(c))
        if (runs.length) out.paragraphs.push({ runs, quote: true })
      }
      return
    }
    if (tag === 'TABLE') {
      for (const row of Array.from(el.querySelectorAll('tr'))) {
        const cells = Array.from(row.children).map(c => (c.textContent ?? '').trim())
        const header = row.parentElement?.tagName.toUpperCase() === 'THEAD'
        out.paragraphs.push({ runs: [{ text: cells.join('  |  '), bold: header }] })
      }
      return
    }
    if (tag === 'HR') return
    if (tag === 'IFRAME') { placeholder(el.getAttribute('title') || 'Contenu intégré'); return }
    if (tag === 'SVG') { placeholder('Schéma'); return }
    // Conteneur (bloc rendu, colonnes, plugin) : ses enfants, dans l'ordre.
    const kids = Array.from(el.children) as HTMLElement[]
    if (!kids.length) {
      const runs = trimRuns(runsOf(el))
      if (runs.length) out.paragraphs.push({ runs })
      return
    }
    for (const c of kids) visit(c, depth, ordered)
  }
  for (const c of Array.from(body.children)) visit(c as HTMLElement, 0, null)
  return out
}

/** Les octets d'une image affichee, en PNG, JPEG ou GIF (null : impossible). */
export async function pictureOf(img: HTMLImageElement): Promise<PptxPicture | null> {
  const src = img.currentSrc || img.src
  if (!src) return null
  try {
    if (!img.complete) await new Promise(r => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 4000) })
    const res = await fetch(src)
    if (!res.ok) return null
    const blob = await res.blob()
    let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer())
    let ext = sniff(bytes)
    if (!ext) {
      // WebP, SVG... : redessine en PNG.
      const png = await toPng(img)
      if (!png) return null
      bytes = png
      ext = 'png'
    }
    return { bytes, ext, width: img.naturalWidth || img.width || 800, height: img.naturalHeight || img.height || 600 }
  } catch {
    return null
  }
}

function sniff(b: Uint8Array): PptxPicture['ext'] | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  return null
}

async function toPng(img: HTMLImageElement): Promise<Uint8Array | null> {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height
  if (!w || !h || typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')
  if (!g) return null
  g.drawImage(img, 0, 0, w, h)
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}
