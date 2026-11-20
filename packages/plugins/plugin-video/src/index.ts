// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Videos (et sons) du vault : un fichier .mp4, .webm, .mov... s'ouvre dans
// un lecteur, et s'integre dans une note comme une image : ![[Demo.mp4]].
// Le lecteur est celui du navigateur (<video controls>) : rien n'est
// transcode, rien ne part ailleurs. On depose ou on colle une video dans une
// note comme une image (editor-core, ImageInsert).
//
// Taille : comme toute piece jointe, 50 Mo au plus par fichier (serveur).
import { BLOCK_DESTROY_EVENT, createIcon } from '@savoire/plugin-api'
import type { PluginAPI, VaultAPI, VaultPlugin } from '@savoire/plugin-api'

export const VIDEO_TYPES: Readonly<Record<string, string>> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
}
export const AUDIO_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
}
const ALL: Readonly<Record<string, string>> = { ...VIDEO_TYPES, ...AUDIO_TYPES }

const extOf = (path: string): string => path.split('.').at(-1)?.toLowerCase() ?? ''
export const isMediaPath = (path: string): boolean => extOf(path) in ALL
export const isVideoPath = (path: string): boolean => extOf(path) in VIDEO_TYPES

/** ![[Demo.mp4]], ![[Demo.mp4|480]] (largeur), seul sur sa ligne. */
export const MEDIA_EMBED_RE = /^\s*!\[\[([^\]|#]+\.(?:mp4|m4v|webm|mov|ogv|mp3|wav|ogg|oga|m4a|flac))(?:\|(\d{2,4}))?\]\]\s*$/i

export function parseMediaEmbed(text: string): { target: string; width?: number } | null {
  const m = MEDIA_EMBED_RE.exec(text)
  if (!m) return null
  return { target: m[1].trim(), width: m[2] ? Number(m[2]) : undefined }
}

/**
 * Adresse lisible par <video> : l'URL de la piece jointe, avec le bon type
 * (le serveur range les fichiers sous leur id, sans extension : il ne connait
 * pas toujours leur type, et certains navigateurs refusent alors de lire).
 */
async function mediaUrl(vault: VaultAPI, path: string): Promise<string> {
  const type = ALL[extOf(path)] ?? 'application/octet-stream'
  const raw = await vault.resolveAttachmentUrl?.(path)
  if (!raw) throw new Error('fichier illisible ici')
  const blob = await (await fetch(raw)).blob()
  return blob.type === type ? raw : URL.createObjectURL(new Blob([blob], { type }))
}

/** Le lecteur : <video> ou <audio>, avec les commandes du navigateur. */
export function createPlayer(vault: VaultAPI, path: string, opts: { width?: number; fill?: boolean } = {}): { el: HTMLElement; dispose(): void } {
  const video = isVideoPath(path)
  const el = document.createElement('div')
  el.className = 'savoire-media'
  el.dataset.testid = 'media-player'
  el.dataset.path = path
  el.style.cssText = opts.fill
    ? 'display:flex;align-items:center;justify-content:center;height:100%;padding:16px;box-sizing:border-box'
    : 'margin:6px 0;line-height:0'
  const media = document.createElement(video ? 'video' : 'audio')
  media.controls = true
  media.preload = 'metadata'
  media.setAttribute('playsinline', '')
  media.style.cssText = video
    ? `display:block;max-width:100%;${opts.fill ? 'max-height:100%;' : ''}border-radius:6px;background:#000${opts.width ? `;width:${opts.width}px` : ''}`
    : 'display:block;width:100%;max-width:520px'
  el.appendChild(media)
  let created: string | null = null
  let dead = false
  void mediaUrl(vault, path).then(url => {
    if (dead) { if (url.startsWith('blob:')) URL.revokeObjectURL(url); return }
    if (url !== created) created = url.startsWith('blob:') ? url : null
    media.src = url
  }, err => {
    const msg = document.createElement('span')
    msg.dataset.testid = 'media-error'
    msg.style.cssText = 'font-size:12px;line-height:1.5;color:var(--text-muted,#888)'
    msg.textContent = `⚠ ${video ? 'Vidéo' : 'Son'} introuvable : ${path} (${String(err?.message ?? err)})`
    el.replaceChildren(msg)
  })
  return {
    el,
    dispose() {
      dead = true
      media.pause()
      media.removeAttribute('src')
      media.load()
    },
  }
}

export function createVideoPlugin(): VaultPlugin {
  let api: PluginAPI | undefined
  return {
    manifest: {
      id: 'plugin-video',
      trust: 'verified',
      name: 'Vidéos et sons',
      version: '0.0.1',
      description: 'Lire les vidéos et les sons du vault, et les intégrer dans les notes : ![[Démo.mp4]]',
      scope: 'vault',
      permissions: ['ui:editor', 'vault:read'],
      defaultActive: true,
    },
    async onload(pluginApi: PluginAPI) {
      api = pluginApi
      for (const ext of Object.keys(ALL)) {
        pluginApi.files.register({
          extension: ext,
          label: ext in VIDEO_TYPES ? 'Vidéo' : 'Son',
          icon: ext in VIDEO_TYPES ? 'film' : 'music',
          creatable: false,
          create: async () => { throw new Error('Une vidéo se dépose ou se colle dans une note.') },
          open: (path: string) => {
            let player: { el: HTMLElement; dispose(): void } | null = null
            return {
              mount(el: HTMLElement) {
                player = createPlayer(pluginApi.vault, path, { fill: true })
                el.appendChild(player.el)
              },
              destroy() { player?.dispose(); player = null },
            }
          },
        })
      }
      pluginApi.blocks?.register({
        type: 'media-embed',
        detect: (text: string) => parseMediaEmbed(text) !== null,
        deserialize: (raw: string) => String(raw).trim(),
        serialize: (data: unknown) => String(data),
        createEditorWidget: () => ({ mount: () => {}, destroy: () => {} }),
        renderClient: (data: unknown) => {
          const embed = parseMediaEmbed(String(data))
          if (!embed || !api) return document.createElement('div')
          const player = createPlayer(api.vault, embed.target, { width: embed.width })
          player.el.addEventListener(BLOCK_DESTROY_EVENT, () => player.dispose(), { once: true })
          const open = document.createElement('a')
          open.href = '#'
          open.title = `Ouvrir ${embed.target}`
          open.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:1.6;color:var(--text-faint,#999)'
          open.append(createIcon(api.icons, isVideoPath(embed.target) ? 'film' : 'music', { size: 12 }), embed.target.split('/').pop() ?? '')
          open.addEventListener('click', e => { e.preventDefault(); void api?.workspace.openFile(embed.target) })
          player.el.append(document.createElement('br'), open)
          return player.el
        },
      })
    },
    async onunload() {
      for (const ext of Object.keys(ALL)) api?.files.unregister(ext)
      api?.blocks?.unregister('media-embed')
      api = undefined
    },
  }
}

const plugin = createVideoPlugin()
export default plugin
