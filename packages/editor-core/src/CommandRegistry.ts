// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { EditorView } from '@codemirror/view'

export interface CommandContext {
  view: EditorView
}

export interface Command {
  id: string
  label?: string
  run(context: CommandContext): void
}

export class CommandRegistry {
  private commands = new Map<string, Command>()

  register(command: Command): void {
    this.commands.set(command.id, command)
  }

  unregister(id: string): void {
    this.commands.delete(id)
  }

  execute(id: string, context: CommandContext): void {
    const command = this.commands.get(id)
    if (!command) {
      console.warn(`[CommandRegistry] Unknown command: ${id}`)
      return
    }
    command.run(context)
  }

  has(id: string): boolean {
    return this.commands.has(id)
  }
}
