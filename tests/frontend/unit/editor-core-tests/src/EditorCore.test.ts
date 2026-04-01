// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
// Import directly from source files to avoid loading EditorCore (codemirror/yjs deps)
import { EventBus } from '../../../../../packages/editor-core/src/EventBus'
import { CommandRegistry } from '../../../../../packages/editor-core/src/CommandRegistry'
import { DocumentPipeline } from '../../../../../packages/editor-core/src/DocumentPipeline'

describe('EventBus', () => {
  it('emits and receives events', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    bus.on('test', handler)
    bus.emit('test', 42)
    expect(handler).toHaveBeenCalledWith(42)
  })

  it('unsubscribes via returned function', () => {
    const bus = new EventBus()
    const handler = vi.fn()
    const off = bus.on('test', handler)
    off()
    bus.emit('test')
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('CommandRegistry', () => {
  it('executes registered command', () => {
    const registry = new CommandRegistry()
    const run = vi.fn()
    registry.register({ id: 'test-cmd', run })
    // @ts-expect-error - mock context
    registry.execute('test-cmd', {})
    expect(run).toHaveBeenCalled()
  })

  it('warns on unknown command', () => {
    const registry = new CommandRegistry()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // @ts-expect-error - mock context
    registry.execute('unknown', {})
    expect(warn).toHaveBeenCalled()
  })
})

describe('DocumentPipeline', () => {
  it('chains beforeParse hooks', async () => {
    const pipeline = new DocumentPipeline()
    pipeline.registerHook('beforeParse', (s) => s.toUpperCase())
    pipeline.registerHook('beforeParse', (s) => `[${s}]`)
    const result = await pipeline.runBeforeParse('hello')
    expect(result).toBe('[HELLO]')
  })
})
