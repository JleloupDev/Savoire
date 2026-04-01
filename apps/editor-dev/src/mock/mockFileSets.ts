// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { MockFileSet } from './types'

export const basicSet: MockFileSet = {
  id: 'basic',
  label: 'Basic Markdown',
  entry: 'index.md',
  files: {
    'index.md': `# Basic Markdown

This is a **bold** word and this is *italic*.

## Lists

- Item one
- Item two
- Item three

1. First
2. Second
3. Third

## Code

\`\`\`ts
const x = 42
console.log(x)
\`\`\`

## Blockquote

> This is a standard blockquote.

---

End of document.
`,
  },
}

export const calloutsSet: MockFileSet = {
  id: 'callouts',
  label: 'Callouts',
  entry: 'index.md',
  files: {
    'index.md': `# Callout Blocks

> [!NOTE]
> This is a **note** callout. Default blue style.

> [!TIP]
> Tip callouts are green.

> [!WARNING]
> Warning callouts are yellow.

> [!DANGER]
> Danger callouts are red.

> [!TODO]
> Todo callouts are purple.

> [!QUESTION]
> Question callouts are cyan.

> [!UNKNOWN]
> Unknown types fall back to the note style.

Text after callouts.
`,
  },
}

export const embedsSet: MockFileSet = {
  id: 'embeds',
  label: 'Embeds (Wikilinks)',
  entry: 'index.md',
  files: {
    'index.md': `# Embeds

Reference to another note: [[note.md]]

Read-only embed (K1):

![[note.md]]

Editable module embed (K2):

@[[modules/goals.md]]

Back to main document.
`,
    'note.md': `## Embedded Note

Hello from the embedded note.

- Point A
- Point B
`,
    'modules/goals.md': `---
type: module
---
## Goals Module

This is an **editable** module document.

- Goal 1
- Goal 2
`,
  },
}

export const excalidrawSet: MockFileSet = {
  id: 'excalidraw',
  label: 'Excalidraw',
  entry: 'index.md',
  files: {
    'index.md': `# Diagram

![[diagram.excalidraw]]

Notes below the diagram.
`,
    'diagram.excalidraw': JSON.stringify({
      elements: [],
      appState: { viewBackgroundColor: '#ffffff' },
    }),
  },
}

export const largeSet: MockFileSet = {
  id: 'large',
  label: 'Large Document (perf)',
  entry: 'large.md',
  files: {
    'large.md': [
      '# Large Document — Performance Test\n',
      ...Array.from({ length: 200 }, (_, i) => `## Section ${i + 1}

Paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

> [!NOTE]
> Note block in section ${i + 1}.

\`\`\`ts
const section${i + 1} = ${i + 1}
\`\`\`

`),
    ].join(''),
  },
}

export const ALL_MOCK_SETS: MockFileSet[] = [
  basicSet,
  calloutsSet,
  embedsSet,
  excalidrawSet,
  largeSet,
]
