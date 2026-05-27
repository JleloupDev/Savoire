// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export class DocumentView {
  static lastOptions: Record<string, unknown> = {}

  constructor(options: Record<string, unknown>) {
    DocumentView.lastOptions = options
  }

  mount(): void {}
  destroy(): void {}
  get controller() { return null }
}
