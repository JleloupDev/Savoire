// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup

// Lightweight document version derived from the Yjs state vector.
// clock = sum of all client clocks in the doc — monotonically increasing, never resets.
// Two clocks can be compared: if stored clock < current clock, the doc has advanced.
export interface CrdtVersion {
  readonly clock: number
}
