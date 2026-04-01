// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Trigger items ───────────────────────────────────────────────────────

export interface TriggerItem {
  id: string
  label: string
  icon?: string
  category?: string
  description?: string
  insert: string | ((query: string) => string)
}

// ─── Input triggers (reserved character patterns) ─────────────────────────
// Plugins declare which character sequences they "own" to prevent conflicts.

export interface TriggerActivation {
  triggerId: string
  character: string
  query: string
  from: number
  /** Viewport-relative position of the trigger character (bottom of line). */
  coords: { x: number; y: number }
  /** Viewport-relative top of the trigger line — used to position menu above the cursor. */
  lineTop: number
}

export interface TriggerHandler {
  getItems(query: string): TriggerItem[]
  onCommit?(activation: TriggerActivation, item: TriggerItem): void
}

export interface InputTrigger {
  /** Unique id — typically the plugin id */
  id: string
  /** Character sequence that activates this trigger, e.g. '/', '[[', '![[' */
  character: string
  pattern?: RegExp            // optional advanced matching (like Obsidian's onTrigger regex)
  description?: string
  handler?: TriggerHandler
}

export interface TriggerRegistry {
  register(trigger: InputTrigger): void
  unregister(id: string): void
  getAll(): InputTrigger[]
  /** Returns the existing trigger if the character is already claimed. */
  findConflict(character: string): InputTrigger | undefined
}

// ─── Slash commands ──────────────────────────────────────────────────────

export interface SlashCommandItem {
  id: string
  label: string
  description?: string
  /** Short icon text displayed in the menu thumbnail (e.g. "H1", "/>", "•"). */
  icon?: string
  /** Category used for visual grouping in the menu. */
  category?: string
  /** Markdown/text to insert, or a function that returns it given the current query. */
  insert: string | ((ctx: { query: string }) => string)
}

export interface SlashRegistry {
  register(item: SlashCommandItem): void
  unregister(id: string): void
  getAll(): SlashCommandItem[]
}
