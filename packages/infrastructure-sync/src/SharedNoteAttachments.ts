// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Images d'une note ouverte par un lien de partage. Le lien ne lit que les
// pieces jointes rangees dans le dossier de la note : le serveur en donne la
// liste (id, nom). `![[Photo.png]]` ou `![[Ma note/Photo.png]]` se resout par
// le nom ; l'image est lue avec le jeton du lien, affichee par une URL blob:.
// Une image rangee ailleurs dans le vault reste introuvable ici.
import type { RestVaultStorage } from './RestVaultStorage'

export class SharedNoteAttachments {
  private list: Promise<Map<string, string>> | null = null
  private readonly urls = new Map<string, Promise<string>>()
  private readonly created: string[] = []

  constructor(
    private readonly storage: RestVaultStorage,
    private readonly vaultId: string,
    private readonly docId: string,
    private readonly token: () => string,
  ) {}

  /** URL affichable de l'image designee par ce lien. Rejette si elle n'est pas dans le dossier de la note. */
  async url(target: string): Promise<string> {
    const name = target.trim().split('/').at(-1) ?? ''
    const id = (await this.names()).get(name)
    if (!id) throw new Error(`piece jointe hors du dossier de la note partagee : ${target}`)
    let url = this.urls.get(id)
    if (!url) {
      url = this.storage.fetchAttachment(this.vaultId, id, this.token()).then(blob => {
        const u = URL.createObjectURL(blob)
        this.created.push(u)
        return u
      })
      url.catch(() => { if (this.urls.get(id) === url) this.urls.delete(id) })
      this.urls.set(id, url)
    }
    return url
  }

  dispose(): void {
    for (const u of this.created.splice(0)) URL.revokeObjectURL(u)
    this.urls.clear()
  }

  /** Nom -> id des images du dossier de la note. Relue si la premiere lecture echoue. */
  private names(): Promise<Map<string, string>> {
    if (!this.list) {
      const list = this.storage.listNoteAttachments(this.vaultId, this.docId, this.token()).then(items => {
        const map = new Map<string, string>()
        for (const item of items) if (item.name) map.set(item.name, item.id)
        return map
      })
      list.catch(() => { if (this.list === list) this.list = null })
      this.list = list
    }
    return this.list
  }
}
