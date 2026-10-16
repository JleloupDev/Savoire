// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'implementation de reference en memoire passe le comportement commun.
import { InMemorySharedTree } from '../../../../../packages/plugin-runtime/src/InMemorySharedTree'
import { describeSharedTreeBehaviour } from './contract/sharedTreeBehaviour'

describeSharedTreeBehaviour('memoire (reference)', () => {
  const a = new InMemorySharedTree()
  const b = new InMemorySharedTree()
  InMemorySharedTree.link(a, b)
  // Les transactions arrivent tout de suite chez l'autre.
  return { a, b, sync: () => {} }
})
