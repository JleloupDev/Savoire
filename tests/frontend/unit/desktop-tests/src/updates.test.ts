// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Mises a jour de l'appli de bureau : commandes appelees, telechargement en
// fond, bon installeur propose par la page de connexion, et fichiers de la
// Release (noms fixes, latest.json).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDesktopUpdates, type TauriBridge } from '@savoire/desktop'
import { findReadyUpdate } from '../../../../../apps/web/src/UpdateBanner'
import { DOWNLOADS, detectDesktopOs, downloadUrl } from '../../../../../apps/web/src/downloads'
// @ts-expect-error script Node sans types
import { ASSETS, prepareRelease } from '../../../../../apps/desktop/scripts/release-assets.mjs'

function bridge(found: unknown) {
  const calls: string[] = []
  const b: TauriBridge = {
    invoke: async <T,>(cmd: string) => { calls.push(cmd); return (cmd === 'update_check' ? found : undefined) as T },
    listen: async () => () => {},
  }
  return { b, calls }
}

describe('mises a jour de l appli', () => {
  it('rien a faire quand l appli est a jour', async () => {
    const { b, calls } = bridge(null)
    expect(await findReadyUpdate(createDesktopUpdates(b))).toBeNull()
    expect(calls).toEqual(['update_check'])
  })

  it('une version trouvee est telechargee avant d etre proposee', async () => {
    const update = { version: '0.3.0', currentVersion: '0.2.0', notes: null }
    const { b, calls } = bridge(update)
    expect(await findReadyUpdate(createDesktopUpdates(b))).toEqual(update)
    expect(calls).toEqual(['update_check', 'update_download'])
  })
})

describe('bouton de telechargement', () => {
  it('reconnait le systeme de l ordinateur', () => {
    expect(detectDesktopOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130')).toBe('windows')
    expect(detectDesktopOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605')).toBe('macos')
    expect(detectDesktopOs('Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0')).toBe('linux')
  })

  it('rien a proposer sur un telephone ou une tablette', () => {
    expect(detectDesktopOs('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36')).toBeNull()
    expect(detectDesktopOs('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148')).toBeNull()
    expect(detectDesktopOs('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/130')).toBeNull()
  })

  it('les liens visent les noms fixes publies par la Release', () => {
    const published = new Set(ASSETS.map((a: { name: string }) => a.name))
    for (const os of Object.values(DOWNLOADS)) {
      for (const f of os.files) expect(published.has(f.file)).toBe(true)
    }
    expect(downloadUrl('Savoire-linux-x86_64.AppImage')).toBe('https://github.com/JleloupDev/Savoire/releases/latest/download/Savoire-linux-x86_64.AppImage')
  })
})

describe('fichiers de la Release', () => {
  const builds = (withDebSig: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), 'savoire-release-'))
    const files = ['nsis/Savoire_0.2.0_x64-setup.exe', 'msi/Savoire_0.2.0_x64_en-US.msi', 'dmg/Savoire_0.2.0_aarch64.dmg',
      'macos/Savoire.app.tar.gz', 'appimage/Savoire_0.2.0_amd64.AppImage', 'deb/Savoire_0.2.0_amd64.deb', 'rpm/Savoire-0.2.0-1.x86_64.rpm']
    for (const f of files) {
      mkdirSync(join(dir, 'in', f, '..'), { recursive: true })
      writeFileSync(join(dir, 'in', f), f)
      if (!f.endsWith('.dmg') && (withDebSig || !/\.(deb|rpm)$/.test(f))) writeFileSync(join(dir, 'in', `${f}.sig`), `sig:${f}`)
    }
    return dir
  }

  it('noms fixes et latest.json, chaque systeme avec son fichier signe', () => {
    const dir = builds(true)
    const manifest = prepareRelease(join(dir, 'in'), join(dir, 'out'), 'v0.2.0', 'JleloupDev/Savoire')
    expect(manifest.version).toBe('0.2.0')
    expect(manifest.platforms['windows-x86_64']).toEqual({
      url: 'https://github.com/JleloupDev/Savoire/releases/download/v0.2.0/Savoire-windows-x64-setup.exe',
      signature: 'sig:nsis/Savoire_0.2.0_x64-setup.exe',
    })
    expect(manifest.platforms['darwin-aarch64'].signature).toBe('sig:macos/Savoire.app.tar.gz')
    expect(manifest.platforms['linux-x86_64-deb'].url).toMatch(/Savoire-linux-amd64\.deb$/)
    expect(readFileSync(join(dir, 'out', 'Savoire-macos-arm64.dmg'), 'utf8')).toBe('dmg/Savoire_0.2.0_aarch64.dmg')
    expect(JSON.parse(readFileSync(join(dir, 'out', 'latest.json'), 'utf8')).version).toBe('0.2.0')
  })

  it('.deb et .rpm non signes : publies, mais hors des mises a jour', () => {
    const dir = builds(false)
    const manifest = prepareRelease(join(dir, 'in'), join(dir, 'out'), 'v0.2.0', 'JleloupDev/Savoire')
    expect(manifest.platforms['linux-x86_64-deb']).toBeUndefined()
    expect(manifest.platforms['linux-x86_64']).toBeDefined()
    expect(existsSync(join(dir, 'out', 'Savoire-linux-amd64.deb'))).toBe(true)
  })

  it('un installeur signe sans signature arrete la Release', () => {
    const dir = builds(true)
    rmSync(join(dir, 'in', 'nsis', 'Savoire_0.2.0_x64-setup.exe.sig'))
    expect(() => prepareRelease(join(dir, 'in'), join(dir, 'out'), 'v0.2.0', 'JleloupDev/Savoire')).toThrow(/signature/)
  })
})
