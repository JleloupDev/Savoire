// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { notify, dismiss, subscribeToasts } from '@savoire/notifications'
import type { Toast } from '@savoire/notifications'

// The store is a module-level singleton. We reset it between tests by
// dismissing all toasts via subscribeToasts, which gives us the current list.
function resetStore() {
  let current: Toast[] = []
  const unsub = subscribeToasts(t => { current = t })
  unsub()
  for (const t of current) dismiss(t.id)
}

beforeEach(() => {
  resetStore()
})

describe('notify()', () => {
  it('adds a toast to the store', () => {
    const received: Toast[][] = []
    const unsub = subscribeToasts(t => received.push(t))

    notify('success', 'Done')

    expect(received.at(-1)).toHaveLength(1)
    expect(received.at(-1)![0]).toMatchObject({ type: 'success', title: 'Done' })
    unsub()
  })

  it('assigns a unique id to each toast', () => {
    notify('info', 'First')
    notify('info', 'Second')

    let toasts: Toast[] = []
    const unsub = subscribeToasts(t => { toasts = t })
    unsub()

    expect(toasts).toHaveLength(2)
    expect(toasts[0].id).not.toBe(toasts[1].id)
  })

  it('supports an optional message', () => {
    notify('warn', 'Title', 'Detail')

    let toasts: Toast[] = []
    const unsub = subscribeToasts(t => { toasts = t })
    unsub()

    expect(toasts[0].message).toBe('Detail')
  })

  it('stacks multiple toasts', () => {
    notify('success', 'A')
    notify('danger', 'B')
    notify('info',    'C')

    let toasts: Toast[] = []
    const unsub = subscribeToasts(t => { toasts = t })
    unsub()

    expect(toasts).toHaveLength(3)
    expect(toasts.map(t => t.title)).toEqual(['A', 'B', 'C'])
  })
})

describe('dismiss()', () => {
  it('removes the toast with the given id', () => {
    notify('info', 'Keep')
    notify('info', 'Remove')

    let toasts: Toast[] = []
    const unsub = subscribeToasts(t => { toasts = t })
    unsub()

    const idToRemove = toasts[1].id
    dismiss(idToRemove)

    let after: Toast[] = []
    const unsub2 = subscribeToasts(t => { after = t })
    unsub2()

    expect(after).toHaveLength(1)
    expect(after[0].title).toBe('Keep')
  })

  it('is a no-op for an unknown id', () => {
    notify('info', 'Toast')

    dismiss(99999)

    let toasts: Toast[] = []
    const unsub = subscribeToasts(t => { toasts = t })
    unsub()

    expect(toasts).toHaveLength(1)
  })
})

describe('subscribeToasts()', () => {
  it('calls the subscriber immediately with current state', () => {
    notify('success', 'Existing')

    const calls: Toast[][] = []
    const unsub = subscribeToasts(t => calls.push(t))
    unsub()

    expect(calls).toHaveLength(1)
    expect(calls[0][0].title).toBe('Existing')
  })

  it('notifies subscriber on each notify() call', () => {
    const calls: Toast[][] = []
    const unsub = subscribeToasts(t => calls.push([...t]))

    notify('info', 'A')
    notify('info', 'B')

    unsub()

    // initial call (empty) + 2 notify calls
    expect(calls).toHaveLength(3)
    expect(calls[1]).toHaveLength(1)
    expect(calls[2]).toHaveLength(2)
  })

  it('notifies subscriber on dismiss()', () => {
    notify('info', 'Toast')
    let toasts: Toast[] = []
    const unsub = subscribeToasts(t => { toasts = t })

    dismiss(toasts[0].id)

    expect(toasts).toHaveLength(0)
    unsub()
  })

  it('stops notifying after unsubscribe', () => {
    const calls: Toast[][] = []
    const unsub = subscribeToasts(t => calls.push(t))
    const countBefore = calls.length

    unsub()
    notify('info', 'After unsub')

    expect(calls.length).toBe(countBefore)
  })

  it('supports multiple independent subscribers', () => {
    const a: number[] = []
    const b: number[] = []

    const unsubA = subscribeToasts(t => a.push(t.length))
    const unsubB = subscribeToasts(t => b.push(t.length))

    notify('success', 'X')
    notify('success', 'Y')

    unsubA()
    unsubB()

    expect(a).toEqual([0, 1, 2])
    expect(b).toEqual([0, 1, 2])
  })
})
