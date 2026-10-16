// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export { EditorCore, plumeCommands } from './EditorCore'
export { resolveActivePlugins } from './PluginActivationResolver'
export type { ActivationEntry, ActivationContext, ActivationSource } from './PluginActivationResolver'
export { EventBus, globalEventBus } from './EventBus'
export { CommandRegistry } from './CommandRegistry'
export { DocumentPipeline } from './DocumentPipeline'
export { DocumentView, isOpenableWithoutPlugin } from './DocumentView'
export { imageInsertion, pastedImageName, imageExtensionOf, isImageFile } from './ImageInsert'
export type { EditorController, EditorCoreOptions, EditorEvent, MarkdownFormat, SelectionCoords, TriggerActivation, ToolbarCommand, ActivePluginInfo } from './types'
export type { Command, CommandContext } from './CommandRegistry'
export type { DocumentViewOptions } from './DocumentView'
