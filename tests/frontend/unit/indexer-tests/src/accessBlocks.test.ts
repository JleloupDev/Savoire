// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pouvoir blocks et droits de l'appelant : une note interdite ne montre ni
// ses blocs, ni sa presence dans les passages partages.
import { describe, expect, it } from 'vitest'
import { filterResult } from '../../../../../apps/indexer/src/access'

const access = { base: 'write', rules: [{ folder: 'Secret', permission: 'none' }], closed: [] }

describe('blocks : droits', () => {
  it('list et shared d une note interdite : rien', () => {
    expect(filterResult(access, 'blocks', 'list', { id: 's', path: 'Secret/S.md', items: [{ index: 0 }] })).toBeNull()
    expect(filterResult(access, 'blocks', 'shared', { id: 's', path: 'Secret/S.md', items: [] })).toBeNull()
  })

  it('find et shared : sans les notes interdites', () => {
    expect(filterResult(access, 'blocks', 'find', { items: [{ id: 'a', path: 'A.md' }, { id: 's', path: 'Secret/S.md' }] }))
      .toEqual({ items: [{ id: 'a', path: 'A.md' }] })
    expect(filterResult(access, 'blocks', 'shared', {
      id: 'a', path: 'A.md',
      items: [
        { index: 1, hash: 'h1', others: [{ id: 's', path: 'Secret/S.md' }] },
        { index: 2, hash: 'h2', others: [{ id: 'b', path: 'B.md' }, { id: 's', path: 'Secret/S.md' }] },
      ],
    })).toEqual({ id: 'a', path: 'A.md', items: [{ index: 2, hash: 'h2', others: [{ id: 'b', path: 'B.md' }] }] })
  })
})
