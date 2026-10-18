// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import {
  HubConnectionBuilder,
  HubConnection,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr'
import type { IDocumentMeta, IVaultDirectory } from '@savoire/platform'
import type { DocumentLockState } from '@savoire/application'
import { VaultGoneError } from '@savoire/application'
import { VaultGoneSignal } from './vaultGone'

const VAULT_COMPACT_THRESHOLD = 100

// Relais d'index : le hub transporte des mises a jour CRDT OPAQUES, une par
// namespace. Remplace l'ancien PushIndexOp, qui expediait le markdown complet
// au serveur pour qu'il le sequence et le rediffuse.

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(binary)
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

export class VaultHubClient {
  private connection: HubConnection | null = null
  private connectPromise: Promise<void> | null = null
  private disposed = false
  private disposing = false
  private pendingCreates = new Map<string, Promise<IDocumentMeta>>()
  private authBlockedUntil = 0
  private indexCallbacks = new Map<string, ((update: Uint8Array) => void)[]>()
  private lockChangedCallbacks: ((docId: string, holder: DocumentLockState | null) => void)[] = []
  private lockRequestedCallbacks: ((docId: string, requesterName: string) => void)[] = []
  private unsubLocalVaultUpdate: (() => void) | null = null
  private readonly unsubGone: () => void
  /** Envois en cours (repertoire, index), pour flush(). */
  private readonly inFlight = new Set<Promise<void>>()
  /** Envois perdus (hub coupe, refus) depuis le dernier settle(). */
  private lostPushes = 0

  constructor(
    private readonly serverUrl: string,
    private readonly vaultId: string,
    private readonly directory: IVaultDirectory,
    private readonly onChanged: () => void,
    private readonly getToken: () => string | null = () => null,
    private readonly onConnectionChange?: (state: 'connected' | 'disconnected') => void,
    /** Partage avec les autres clients du vault : le premier « vault-not-found » arrete tout. */
    readonly gone: VaultGoneSignal = new VaultGoneSignal(vaultId),
  ) {
    this.unsubLocalVaultUpdate = this.directory.onLocalUpdate(
      (update) => void this.pushVaultUpdate(update),
    )
    // Vault perdu : plus de reconnexion automatique ni de nouvel essai.
    this.unsubGone = this.gone.onGone(() => {
      if (this.connection && this.connection.state !== HubConnectionState.Disconnected)
        void this.connection.stop().catch(() => {})
    })
  }

  async connect(): Promise<void> {
    if (this.disposed || this.gone.gone) return
    if (Date.now() < this.authBlockedUntil) return
    if (this.connection?.state === HubConnectionState.Connected) return
    if (this.connectPromise) return this.connectPromise

    if (!this.connection) {
      this.connection = new HubConnectionBuilder()
        .withUrl(`${this.serverUrl}/hubs/vault`, {
          accessTokenFactory: () => this.getToken() ?? '',
        })
        .configureLogging(LogLevel.None)
        .withAutomaticReconnect()
        .build()

      // ── Vault CRDT init (replaces VaultSnapshot) ──────────────────────────
      this.connection.on('InitVault', (_vaultId: string, ops: string[]) => {
        for (const op of ops) this.directory.applyUpdate(fromBase64(op))
        if (ops.length > VAULT_COMPACT_THRESHOLD) {
          const snapshot = toBase64(this.directory.encodeFullState())
          void this.connection?.invoke('SnapshotVault', this.vaultId, snapshot)
            .catch(err => { if (!this.gone.check(err)) console.error(err) })
        }
        this.onChanged()
      })

      // ── Incremental vault CRDT updates ────────────────────────────────────
      this.connection.on('VaultOperationReceived', (_vaultId: string, opBase64: string) => {
        this.directory.applyUpdate(fromBase64(opBase64))
        this.onChanged()
      })

      // ── Index : mises a jour CRDT opaques, par namespace ──────────────────
      this.connection.on('IndexUpdateReceived', (_vaultId: string, namespace: string, updateBase64: string) => {
        const cbs = this.indexCallbacks.get(namespace)
        if (!cbs) return
        const update = fromBase64(updateBase64)
        for (const cb of cbs) cb(update)
      })

      // ── Verrous d'edition ─────────────────────────────────────────────────
      this.connection.on('LockChanged', (_v: string, docId: string, userId: string | null, name: string | null) => {
        const holder = userId
          ? { holderUserId: userId, holderDisplayName: name ?? userId, isHeldByCaller: false }
          : null
        for (const cb of this.lockChangedCallbacks) cb(docId, holder)
      })
      this.connection.on('LockRequested', (_v: string, docId: string, _u: string, name: string) => {
        for (const cb of this.lockRequestedCallbacks) cb(docId, name)
      })

      // ── Acces au vault modifie (membre retire, vault supprime) ────────────
      // Le serveur ne dit pas qui est concerne : chacun reverifie le sien.
      this.connection.on('VaultAccessChanged', () => { void this.checkAccess() })

      // ── Reconnection: rejoin to get fresh vault CRDT state ────────────────
      this.connection.onreconnected(async () => {
        if (this.gone.gone || this.disposed || !this.connection) return
        try {
          await this.connection!.invoke('JoinVault', this.vaultId)
          this.onConnectionChange?.('connected')
        } catch (err) {
          if (this.gone.check(err)) return
          this.onConnectionChange?.('connected')
          console.error('[VaultHub] Failed to rejoin after reconnect', err)
          if (this.isUnauthorizedError(err)) this.blockOnUnauthorized()
        }
      })

      this.connection.onclose((err?: Error) => {
        // Vault perdu : la session previent deja, pas de « deconnecte » en plus.
        if (!this.disposing && !this.gone.gone) this.onConnectionChange?.('disconnected')
        if (this.isUnauthorizedError(err)) this.blockOnUnauthorized()
      })
    }

    this.connectPromise = (async () => {
      try {
        if (this.connection!.state === HubConnectionState.Disconnected)
          await this.connection!.start()
        if (this.connection!.state === HubConnectionState.Connected)
          await this.connection!.invoke('JoinVault', this.vaultId)
      } catch (err) {
        if (this.gone.check(err)) return
        if (this.isUnauthorizedError(err)) this.blockOnUnauthorized()
        console.warn('[VaultHub] Connection failed — filetree may be stale', err)
      } finally {
        this.connectPromise = null
      }
    })()

    return this.connectPromise
  }

  get isConnected(): boolean {
    return this.connection?.state === HubConnectionState.Connected
  }

  // ── Vault CRDT ────────────────────────────────────────────────────────────

  async pushVaultUpdate(update: Uint8Array): Promise<void> {
    if (!this.isConnected) { this.lostPushes++; return }
    await this.track((async () => {
      try {
        await this.connection!.invoke('PushVaultOperation', this.vaultId, toBase64(update))
      } catch (err) {
        this.lostPushes++
        if (!this.gone.check(err)) console.warn('[VaultHub] pushVaultUpdate failed', err)
      }
    })())
  }

  /** Envoie un etat complet du repertoire, et rejette en cas d'echec (rattrapage de flush). */
  async pushVaultStateOrThrow(state: Uint8Array): Promise<void> {
    const connection = await this._ensureConnected()
    await connection.invoke('PushVaultOperation', this.vaultId, toBase64(state))
  }

  /** Envoie un etat complet d'index, et rejette en cas d'echec (rattrapage de flush). */
  async pushIndexStateOrThrow(namespace: string, state: Uint8Array): Promise<void> {
    const connection = await this._ensureConnected()
    await connection.invoke('PushIndexUpdate', this.vaultId, namespace, toBase64(state))
  }

  /**
   * Attend la fin des envois en cours. Rend le nombre d'envois perdus : a
   * l'appelant de renvoyer l'etat, puis de l'acquitter (acknowledgeLost).
   */
  async settle(): Promise<number> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight])
    return this.lostPushes
  }

  /** L'etat complet a ete renvoye : ces pertes sont rattrapees. */
  acknowledgeLost(count: number): void {
    this.lostPushes = Math.max(0, this.lostPushes - count)
  }

  private track(p: Promise<void>): Promise<void> {
    this.inFlight.add(p)
    void p.finally(() => this.inFlight.delete(p))
    return p
  }

  /** Reverifie le droit de lire le vault. Un refus « vault-not-found » allume le signal. */
  async checkAccess(): Promise<void> {
    if (!this.isConnected || this.gone.gone) return
    try {
      await this.connection!.invoke('CheckVaultAccess', this.vaultId)
    } catch (err) {
      if (!this.gone.check(err)) console.warn('[VaultHub] checkAccess failed', err)
    }
  }

  // ── Registre « document -> vault » ──────────────────────────────────────

  /** Inscrit des documents dans le vault (mode serveur). Rend ceux refuses. */
  async registerDocuments(docIds: string[]): Promise<string[]> {
    const connection = await this._ensureConnected()
    try {
      return await connection.invoke<string[]>('RegisterDocuments', this.vaultId, docIds)
    } catch (err) {
      if (this.gone.check(err)) throw new VaultGoneError(this.vaultId)
      throw err
    }
  }

  // ── Index ops ─────────────────────────────────────────────────────────────

  /** Rejoint le canal d'index d'un namespace et rend les ops deja stockees. */
  async joinIndex(namespace: string): Promise<Uint8Array[]> {
    if (this.disposed || this.gone.gone) return []
    try {
      const connection = await this._ensureConnected()
      const ops = await connection.invoke<string[]>('JoinIndex', this.vaultId, namespace)
      return ops.map(fromBase64)
    } catch (err) {
      if (!this.gone.check(err)) console.warn('[VaultHub] joinIndex failed', err)
      return []
    }
  }

  async pushIndexUpdate(namespace: string, update: Uint8Array): Promise<void> {
    if (!this.isConnected) { this.lostPushes++; return }
    await this.track((async () => {
      try {
        await this.connection!.invoke('PushIndexUpdate', this.vaultId, namespace, toBase64(update))
      } catch (err) {
        this.lostPushes++
        if (!this.gone.check(err)) console.warn('[VaultHub] pushIndexUpdate failed', err)
      }
    })())
  }

  onIndexUpdate(namespace: string, cb: (update: Uint8Array) => void): () => void {
    const list = this.indexCallbacks.get(namespace) ?? []
    list.push(cb)
    this.indexCallbacks.set(namespace, list)
    return () => {
      const cur = this.indexCallbacks.get(namespace)
      if (!cur) return
      this.indexCallbacks.set(namespace, cur.filter(x => x !== cb))
    }
  }

  // ── Verrous d'edition ─────────────────────────────────────────────────────

  async acquireLock(docId: string): Promise<DocumentLockState | null> {
    try {
      const connection = await this._ensureConnected()
      return await connection.invoke<DocumentLockState | null>('AcquireLock', this.vaultId, docId)
    } catch (err) {
      if (!this.gone.check(err)) console.warn('[VaultHub] acquireLock failed', err)
      return null
    }
  }

  async getLock(docId: string): Promise<DocumentLockState | null> {
    try {
      const connection = await this._ensureConnected()
      return await connection.invoke<DocumentLockState | null>('GetLock', this.vaultId, docId)
    } catch (err) { this.gone.check(err); return null }
  }

  async releaseLock(docId: string): Promise<void> {
    if (!this.isConnected) return
    try { await this.connection!.invoke('ReleaseLock', this.vaultId, docId) }
    catch (err) { if (!this.gone.check(err)) console.warn('[VaultHub] releaseLock failed', err) }
  }

  async requestLock(docId: string): Promise<void> {
    if (!this.isConnected) return
    try { await this.connection!.invoke('RequestLock', this.vaultId, docId) }
    catch (err) { if (!this.gone.check(err)) console.warn('[VaultHub] requestLock failed', err) }
  }

  onLockChanged(cb: (docId: string, holder: DocumentLockState | null) => void): () => void {
    this.lockChangedCallbacks.push(cb)
    return () => { this.lockChangedCallbacks = this.lockChangedCallbacks.filter(x => x !== cb) }
  }

  onLockRequested(cb: (docId: string, requesterName: string) => void): () => void {
    this.lockRequestedCallbacks.push(cb)
    return () => { this.lockRequestedCallbacks = this.lockRequestedCallbacks.filter(x => x !== cb) }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    this.disposed = true
    this.disposing = true
    this.unsubGone()
    this.unsubLocalVaultUpdate?.()
    this.unsubLocalVaultUpdate = null
    this.pendingCreates.clear()
    if (this.connection) {
      try { await this.connection.stop() } catch { /* ignore */ }
      this.connection = null
    }
  }

  private async _ensureConnected(): Promise<HubConnection> {
    if (this.gone.gone) throw new VaultGoneError(this.vaultId)
    await this.connect()
    if (this.gone.gone) throw new VaultGoneError(this.vaultId)
    if (!this.connection || this.connection.state !== HubConnectionState.Connected)
      throw new Error('VaultHub not connected')
    return this.connection
  }

  private isUnauthorizedError(err: unknown): boolean {
    const text = String(err ?? '')
    return text.includes('401') || text.toLowerCase().includes('unauthorized')
  }

  private blockOnUnauthorized(): void {
    this.authBlockedUntil = Date.now() + 60_000
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected)
      void this.connection.stop().catch(() => {})
  }

}
