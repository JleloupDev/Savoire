// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-animation — « Animations » : de petites animations ecrites en code
// avec anime.js v4 (fichiers .anim), jouees dans une iframe isolee.
//
//  - un type de document (.anim), son editeur (code + scene + frise) ;
//  - un bloc ![[x.anim]] : l'animation se joue dans une note, une
//    diapositive, une page partagee ;
//  - une revision liee au timecode : commentaires sur un instant, une plage,
//    un element de la scene ;
//  - des outils d'agent (animation_*), aussi pour ChatGPT et Claude par le MCP.
//
// Il n'utilise que l'API des plugins, comme les autres types de documents.
import type { FileContext, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { animationAgentTools } from './agentTools'
import { renderAnimationEmbed } from './embed'
import { ANIM_EXTENSION, parseAnimEmbed } from './format'
import { ANIMATION_MANIFEST } from './manifest'
import { createAnimationView } from './view'

export {
  ANIM_EXTENSION, ANIM_TEMPLATE, ANIM_EMBED_RE, animationParts, composeAnimation, replaceParts, checkKeyframes,
  formatTimecode, parseTimecode, parseAnimEmbed, animEmbedText, describeTarget, isAnimTarget,
  type AnimParts, type AnimEmbed, type AnimCommentTarget,
} from './format'
export { buildSrcdoc, ANIM_CSP, setAnimationFrameUrl, animationFrameUrl } from './frame'
export { AnimationPlayer } from './player'
export { setAnimeSource } from './anime'
export { timecodeThreads } from './review'
export { animationAgentTools } from './agentTools'
export { renderAnimationEmbed } from './embed'
export { createAnimationView } from './view'
export { ANIMATION_MANIFEST } from './manifest'

export function createAnimationPlugin(): VaultPlugin {
  let api: PluginAPI | undefined
  const unregister: (() => void)[] = []
  return {
    manifest: ANIMATION_MANIFEST,
    async onload(pluginApi: PluginAPI) {
      api = pluginApi
      pluginApi.files.register({
        extension: ANIM_EXTENSION,
        label: 'Animation',
        icon: 'clapperboard',
        // Le code est un texte partage : edition a plusieurs, sans verrou.
        collaborationMode: 'crdt',
        creatable: true,
        // Un type 'crdt' nait vide ; la vue propose l'exemple (ANIM_TEMPLATE).
        create: async () => '',
        open: (path: string, ctx: FileContext) => createAnimationView(path, ctx, api),
      })
      pluginApi.blocks?.register({
        type: 'anim-embed',
        detect: (text: string) => parseAnimEmbed(text) !== null,
        deserialize: (raw: string) => String(raw).trim(),
        serialize: (data: unknown) => String(data),
        createEditorWidget: () => ({ mount: () => {}, destroy: () => {} }),
        renderClient: (data: unknown) => {
          const embed = parseAnimEmbed(String(data))
          return embed ? renderAnimationEmbed(embed, api) : document.createElement('div')
        },
      })
      for (const tool of animationAgentTools(pluginApi)) {
        const off = pluginApi.agents?.registerTool(tool)
        if (off) unregister.push(off)
      }
    },
    async onunload() {
      api?.files.unregister(ANIM_EXTENSION)
      api?.blocks?.unregister('anim-embed')
      for (const off of unregister.splice(0)) off()
      api = undefined
    },
  }
}

const plugin = createAnimationPlugin()
export default plugin
