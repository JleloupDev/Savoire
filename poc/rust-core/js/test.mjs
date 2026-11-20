// Tests et mesures du prototype. Lancer : node js/test.mjs (apres ./build.sh)
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import * as Y from 'yjs'

const wasmPath = new URL('../pkg/savoire_core_bg.wasm', import.meta.url)
const bytes = readFileSync(wasmPath)

// --- Chargement -------------------------------------------------------------
const t0 = performance.now()
const mod = await import('../pkg/savoire_core.js')
const tCompile0 = performance.now()
const compiled = await WebAssembly.compile(bytes)
const tCompile = performance.now() - tCompile0
mod.initSync({ module: compiled })
const tLoad = performance.now() - t0
const { CoreDoc } = mod

const results = {}
results.wasm = { brut: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length }
results.chargement_ms = { compile: +tCompile.toFixed(1), total: +tLoad.toFixed(1) }

let passed = 0
const ok = (name, fn) => {
  fn()
  passed++
  console.log('ok  ', name)
}
const ytext = (d) => d.getText('content').toString()

// --- Compatibilite Yjs ------------------------------------------------------
ok('Rust -> Yjs : une mise a jour du coeur s applique dans un Y.Doc', () => {
  const core = new CoreDoc(1)
  const u = core.edit(Uint32Array.from([0, 0]), ['Bonjour 😀 le monde'])
  const y = new Y.Doc()
  Y.applyUpdate(y, u)
  assert.equal(ytext(y), 'Bonjour 😀 le monde')
  // suppression en UTF-16 apres l'emoji (2 unites)
  const u2 = core.edit(Uint32Array.from([8, 10]), [''])
  Y.applyUpdate(y, u2)
  assert.equal(ytext(y), 'Bonjour  le monde')
  assert.equal(core.toString(), ytext(y))
})

ok('Yjs -> Rust : une mise a jour Yjs s applique dans le coeur, avec delta', () => {
  const y = new Y.Doc()
  y.clientID = 7
  y.getText('content').insert(0, 'abc')
  const core = new CoreDoc(2)
  const d1 = core.applyUpdate(Y.encodeStateAsUpdate(y))
  assert.deepEqual(d1, [1, 'abc'])
  const sv = Y.encodeStateVector(y)
  y.getText('content').insert(1, 'XY')
  const d2 = core.applyUpdate(Y.encodeStateAsUpdate(y, sv))
  assert.deepEqual(d2, [0, 1, 1, 'XY'])
  assert.equal(core.toString(), 'aXYbc')
})

ok('Echange par vecteurs d etat (sync pas a pas) dans les deux sens', () => {
  const core = new CoreDoc(3)
  const y = new Y.Doc()
  core.edit(Uint32Array.from([0, 0]), ['rust '])
  y.getText('content').insert(0, 'yjs ')
  const forY = core.encodeStateAsUpdate(Y.encodeStateVector(y))
  const forCore = Y.encodeStateAsUpdate(y, core.stateVector())
  Y.applyUpdate(y, forY)
  core.applyUpdate(forCore)
  assert.equal(core.toString(), ytext(y))
})

ok('Edition parallele : 2 coeurs + 1 Yjs convergent (fuzz 300 tours)', () => {
  let seed = 42
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n)
  const a = new CoreDoc(10)
  const b = new CoreDoc(11)
  const y = new Y.Doc()
  y.clientID = 12
  const yt = y.getText('content')
  const alpha = 'abcdefgh é😀\n'
  const randomEdit = (len) => {
    const pos = rnd(len + 1)
    if (len > 0 && rnd(3) === 0) {
      const del = Math.min(1 + rnd(4), len - pos)
      return [pos, pos + del, '']
    }
    let s = ''
    for (let k = 0, n = 1 + rnd(5); k < n; k++) s += [...alpha][rnd([...alpha].length)]
    return [pos, pos, s]
  }
  const fix = (str, i) => {
    // ne pas couper une paire de substitution
    const c = str.charCodeAt(i - 1)
    return i > 0 && c >= 0xd800 && c <= 0xdbff ? i - 1 : i
  }
  for (let round = 0; round < 300; round++) {
    // chacun edite sans voir les autres
    const outs = []
    for (const core of [a, b]) {
      const s = core.toString()
      let [from, to, ins] = randomEdit(s.length)
      from = fix(s, from)
      to = Math.max(from, fix(s, to))
      outs.push(['core', core, core.edit(Uint32Array.from([from, to]), [ins])])
    }
    {
      const s = yt.toString()
      let [from, to, ins] = randomEdit(s.length)
      from = fix(s, from)
      to = Math.max(from, fix(s, to))
      const sv = Y.encodeStateVector(y)
      y.transact(() => {
        if (to > from) yt.delete(from, to - from)
        if (ins) yt.insert(from, ins)
      })
      outs.push(['y', y, Y.encodeStateAsUpdate(y, sv)])
    }
    // diffusion dans le desordre
    for (const [, src, u] of outs.reverse()) {
      for (const dst of [a, b, y]) {
        if (dst === src || u.length === 0) continue
        if (dst === y) Y.applyUpdate(y, u)
        else dst.applyUpdate(u)
      }
    }
    assert.equal(a.toString(), b.toString(), `tour ${round}`)
    assert.equal(a.toString(), yt.toString(), `tour ${round}`)
  }
  results.fuzz_longueur_finale = a.toString().length
})

ok('Positions relatives : encodage compatible Yjs dans les deux sens', () => {
  const core = new CoreDoc(20)
  const y = new Y.Doc()
  Y.applyUpdate(y, core.edit(Uint32Array.from([0, 0]), ['0123456789']))
  const rel = core.relativePosition(5, 1)
  // un pair distant insere avant la position
  const sv = Y.encodeStateVector(y)
  y.getText('content').insert(2, 'ABC')
  core.applyUpdate(Y.encodeStateAsUpdate(y, sv))
  assert.equal(core.resolvePosition(rel), 8)
  const yAbs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(rel), y)
  assert.equal(yAbs.index, 8)
  const yRel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(y.getText('content'), 1))
  assert.equal(core.resolvePosition(yRel), 1)
})

ok('Annulation : seulement nos frappes, pas celles du pair', () => {
  const core = new CoreDoc(30)
  const y = new Y.Doc()
  Y.applyUpdate(y, core.edit(Uint32Array.from([0, 0]), ['moi ']))
  core.stopCapturing()
  const sv = Y.encodeStateVector(y)
  y.getText('content').insert(4, 'lui')
  core.applyUpdate(Y.encodeStateAsUpdate(y, sv))
  assert.equal(core.toString(), 'moi lui')
  const d = core.undo()
  assert.deepEqual(d, [2, 4])
  assert.equal(core.toString(), 'lui')
  Y.applyUpdate(y, core.takeOutbox())
  assert.equal(ytext(y), 'lui')
  core.redo()
  Y.applyUpdate(y, core.takeOutbox())
  assert.equal(ytext(y), 'moi lui')
})

// --- CodeMirror (happy-dom) -------------------------------------------------
const { Window } = await import('happy-dom')
const win = new Window()
for (const k of ['window', 'document', 'navigator', 'MutationObserver', 'requestAnimationFrame', 'getComputedStyle', 'Node', 'HTMLElement', 'Element', 'Text', 'DOMRect']) {
  if (!(k in globalThis) || k === 'navigator') {
    try {
      Object.defineProperty(globalThis, k, { value: k === 'window' ? win : win[k], configurable: true, writable: true })
    } catch {}
  }
}
const { EditorState } = await import('@codemirror/state')
const { EditorView } = await import('@codemirror/view')
const { rustCollab } = await import('./cm-binding.mjs')

function makePeer(id, net) {
  const core = new CoreDoc(id)
  const collab = rustCollab(core, { send: (u) => net.broadcast(id, u) })
  const view = new EditorView({
    state: EditorState.create({ doc: '', extensions: [collab.extension] }),
    parent: document.body,
  })
  const peer = { id, core, collab, view }
  net.peers.push(peer)
  return peer
}
function makeNet() {
  const net = {
    peers: [],
    queue: [],
    broadcast(from, u) {
      net.queue.push([from, u])
    },
    flush() {
      while (net.queue.length) {
        const [from, u] = net.queue.shift()
        for (const p of net.peers) if (p.id !== from) p.collab.receive(p.view, u)
      }
    },
  }
  return net
}
const type = (view, pos, text) => view.dispatch({ changes: { from: pos, insert: text }, userEvent: 'input.type' })

ok('CodeMirror : frappe -> coeur -> pair distant -> editeur', () => {
  const net = makeNet()
  const A = makePeer(100, net)
  const B = makePeer(101, net)
  type(A.view, 0, 'Hello')
  net.flush()
  assert.equal(B.view.state.doc.toString(), 'Hello')
  type(B.view, 5, ' 😀 monde')
  type(A.view, 0, '>> ')
  net.flush()
  assert.equal(A.view.state.doc.toString(), B.view.state.doc.toString())
  assert.equal(A.view.state.doc.toString(), '>> Hello 😀 monde')
  assert.equal(A.core.toString(), A.view.state.doc.toString())
  // changement multiple (plusieurs curseurs) en une transaction
  A.view.dispatch({ changes: [{ from: 0, to: 3 }, { from: 8, insert: ',' }] })
  net.flush()
  assert.equal(B.view.state.doc.toString(), 'Hello, 😀 monde')
})

ok('CodeMirror : annulation locale, selection gardee par position relative', () => {
  const net = makeNet()
  const A = makePeer(200, net)
  const B = makePeer(201, net)
  type(A.view, 0, 'abc')
  net.flush()
  A.core.stopCapturing()
  type(B.view, 3, 'XYZ')
  net.flush()
  A.view.dispatch({ selection: { anchor: 4 } })
  const saved = A.collab.saveSelection(A.view)
  type(B.view, 0, '123')
  net.flush()
  A.collab.restoreSelection(A.view, saved)
  assert.equal(A.view.state.selection.main.head, 7)
  A.collab.undo(A.view)
  net.flush()
  assert.equal(A.view.state.doc.toString(), '123XYZ')
  assert.equal(B.view.state.doc.toString(), '123XYZ')
})

// --- Mesures ----------------------------------------------------------------
// cout d'une frappe : coeur seul, coeur + CodeMirror, Yjs seul (reference).
// Deux passes, on garde la seconde (JIT chaud).
for (let pass = 0; pass < 2; pass++) {
  const N = 5000
  const core = new CoreDoc(300 + 10 * pass)
  let t = performance.now()
  for (let i = 0; i < N; i++) core.edit(Uint32Array.from([i, i]), ['a'])
  const coreUs = ((performance.now() - t) / N) * 1000

  const y = new Y.Doc()
  const yt = y.getText('content')
  let yUpdates = 0
  y.on('update', (u) => (yUpdates += u.length))
  t = performance.now()
  for (let i = 0; i < N; i++) yt.insert(i, 'a')
  const yUs = ((performance.now() - t) / N) * 1000

  const net = makeNet()
  const A = makePeer(301 + 10 * pass, net)
  t = performance.now()
  for (let i = 0; i < N; i++) type(A.view, i, 'a')
  const cmUs = ((performance.now() - t) / N) * 1000
  net.queue.length = 0

  const plain = new EditorView({ state: EditorState.create({ doc: '' }), parent: document.body })
  t = performance.now()
  for (let i = 0; i < N; i++) type(plain, i, 'a')
  const cmPlainUs = ((performance.now() - t) / N) * 1000

  const y2 = new Y.Doc()
  y2.on('update', () => {})
  const { yCollab } = await import('y-codemirror.next')
  const yView = new EditorView({
    state: EditorState.create({ doc: '', extensions: [yCollab(y2.getText('content'), null)] }),
    parent: document.body,
  })
  t = performance.now()
  for (let i = 0; i < N; i++) type(yView, i, 'a')
  const cmYjsUs = ((performance.now() - t) / N) * 1000
  assert.equal(y2.getText('content').length, N)
  for (const v of [A.view, plain, yView]) v.destroy()

  results.frappe_us = {
    codemirror_plus_yjs_reference: +cmYjsUs.toFixed(1),
    coeur_rust: +coreUs.toFixed(1),
    yjs_seul: +yUs.toFixed(1),
    codemirror_plus_coeur: +cmUs.toFixed(1),
    codemirror_seul: +cmPlainUs.toFixed(1),
  }
}
{
  // grosse note : 1 Mo de texte (1) en un bloc, (2) issu de 20 000 frappes dispersees
  const line = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, é😀.\n'
  const big = line.repeat(Math.ceil(1_000_000 / line.length)).slice(0, 1_000_000)
  const measure = (label, buildCore, buildY) => {
    const src = buildCore()
    const update = src.encodeStateAsUpdate()
    let t = performance.now()
    const c = new CoreDoc(0)
    c.applyUpdate(update)
    const coreMs = performance.now() - t
    t = performance.now()
    const s = c.toString()
    const strMs = performance.now() - t
    const yu = buildY()
    t = performance.now()
    const y = new Y.Doc()
    Y.applyUpdate(y, yu)
    const yMs = performance.now() - t
    assert.equal(s.length, ytext(y).length)
    results[label] = {
      taille_maj_ko: Math.round(update.length / 1024),
      chargement_coeur_ms: +coreMs.toFixed(1),
      toString_coeur_ms: +strMs.toFixed(1),
      chargement_yjs_ms: +yMs.toFixed(1),
    }
  }
  measure(
    'note_1Mo_un_bloc',
    () => {
      const c = new CoreDoc(400)
      c.edit(Uint32Array.from([0, 0]), [big])
      return c
    },
    () => {
      const y = new Y.Doc()
      y.getText('content').insert(0, big)
      return Y.encodeStateAsUpdate(y)
    },
  )
  // fragmentee : meme suite d'editions dans les deux, positions pseudo-aleatoires
  let seed = 7
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n)
  const ops = []
  let len = 0
  const chunk = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit sed do. '
  while (len < 1_000_000) {
    const pos = rnd(len + 1)
    ops.push(pos)
    len += chunk.length
  }
  results.note_1Mo_fragmentee_nb_editions = ops.length
  measure(
    'note_1Mo_fragmentee',
    () => {
      const c = new CoreDoc(401)
      for (const p of ops) c.edit(Uint32Array.from([p, p]), [chunk])
      return c
    },
    () => {
      const y = new Y.Doc()
      const t = y.getText('content')
      for (const p of ops) t.insert(p, chunk)
      return Y.encodeStateAsUpdate(y)
    },
  )
}

console.log(`\n${passed} tests ok\n`)
console.log(JSON.stringify(results, null, 2))
