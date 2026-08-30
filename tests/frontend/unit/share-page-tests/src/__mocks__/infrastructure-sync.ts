// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
const noop = () => () => {}

export class YjsCrdtAdapter {
  onLocalOp(_cb: unknown) { return noop() }
  onLocalPresenceChanged(_cb: unknown) { return noop() }
  onTextChange(_cb: unknown) { return noop() }
  applyRemoteOp(_op: unknown) {}
  applyRemotePresence(_bytes: unknown) {}
  getSnapshot() { return new Uint8Array() }
}

export class SignalRTransport {
  constructor(_options: unknown) {}
  push(_op: unknown) { return Promise.resolve() }
  pushPresence(_bytes: unknown) { return Promise.resolve() }
  pushSnapshot(_snap: unknown) { return Promise.resolve() }
  onInit(_cb: unknown) { return noop() }
  onRemoteOp(_cb: unknown) { return noop() }
  onRemotePresence(_cb: unknown) { return noop() }
  join(_vaultId: string, _docId: string) { return Promise.resolve() }
  disconnect() { return Promise.resolve() }
  getState(): 'disconnected' { return 'disconnected' }
}
