// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// SlashMenu — kept for backward compatibility.
// Now delegates to TriggerOverlay which handles all InputTrigger-based overlays.
// The "/" trigger is registered by EditorCore with a handler that reads from SlashRegistry.
export { TriggerOverlay as SlashMenu } from './TriggerOverlay'
