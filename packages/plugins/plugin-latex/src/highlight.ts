// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Coloration du source LaTeX : commandes, formules, commentaires, accolades.
// Un petit analyseur par ligne (StreamLanguage de CodeMirror), sans paquet
// de plus ; couleurs du style par defaut de CodeMirror.
import { StreamLanguage, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

interface State { math: false | '$' | '$$' | '\\[' | '\\(' }

const latex = StreamLanguage.define<State>({
  name: 'latex',
  startState: () => ({ math: false }),
  copyState: s => ({ ...s }),
  token(stream, state) {
    if (stream.match('%')) { stream.skipToEnd(); return 'comment' }
    if (state.math) {
      const close = state.math === '\\[' ? '\\]' : state.math === '\\(' ? '\\)' : state.math
      if (stream.match(close)) { state.math = false; return 'keyword' }
      if (stream.match(/^\\[A-Za-z]+/)) return 'atom'
      stream.next()
      return 'string'
    }
    if (stream.match('$$')) { state.math = '$$'; return 'keyword' }
    if (stream.match('$')) { state.math = '$'; return 'keyword' }
    if (stream.match('\\[')) { state.math = '\\['; return 'keyword' }
    if (stream.match('\\(')) { state.math = '\\('; return 'keyword' }
    if (stream.match(/^\\(begin|end)\b/)) return 'keyword'
    if (stream.match(/^\\(part|chapter|(sub)*section|paragraph)\*?/)) return 'heading'
    if (stream.match(/^\\[A-Za-z]+\*?/) || stream.match(/^\\./)) return 'tagName'
    if (stream.match(/^[{}[\]]/)) return 'bracket'
    stream.next()
    return null
  },
})

export function latexLanguage(): Extension {
  // Le style par defaut de CodeMirror colore deja ces categories.
  return [latex, syntaxHighlighting(defaultHighlightStyle)]
}
