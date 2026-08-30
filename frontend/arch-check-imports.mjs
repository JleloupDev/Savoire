#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// arch-check-imports.mjs — PROTECTED FILE
//
// Do NOT modify this file without an explicit request from the user.
// It encodes ALL import boundary rules for the frontend monorepo:
//   - npm package restrictions (not detectable by dependency-cruiser in
//     this pnpm + moduleResolution:bundler setup)
//   - @savoire/* cross-package restrictions
//   - apps/* boundary rules
//
// Companion to .dependency-cruiser.cjs which handles circular dependency
// detection and dependency graph generation.
//
// Run: node arch-check-imports.mjs  (from frontend/)
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, relative, dirname, join, basename } from 'path'
import { fileURLToPath } from 'url'

const ROOT       = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKGS       = resolve(ROOT, 'packages')
const APPS       = resolve(ROOT, 'apps')

// ── Helpers ──────────────────────────────────────────────────────────────────

function walkTs(dir, acc = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory() && e.name !== 'node_modules' && e.name !== 'dist') {
      walkTs(full, acc)
    } else if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) && !e.name.endsWith('.d.ts')) {
      acc.push(full)
    }
  }
  return acc
}

function src(pkgPath) {
  return walkTs(join(pkgPath, 'src'))
}

function extractImports(file) {
  const text = readFileSync(file, 'utf-8')
  return [...text.matchAll(/^(?:import|export)\s[^'"]*from\s['"]([^'"]+)['"]/gm)]
    .map(m => m[1])
}

const pkg = (name) => `@savoire/${name}`

// ── Rule definitions ──────────────────────────────────────────────────────────
//
// allowedSavoire : @savoire/* packages that MAY be imported (others → error)
// bannedNpm      : npm specifier prefixes that MUST NOT be imported
// files          : glob-resolved list of source files to check

const pluginDirs = readdirSync(`${PKGS}/plugins`, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name)

const RULES = [

  // ── Absolute leaves (no @savoire/* deps) ───────────────────────────────────
  {
    label: 'domain-index — leaf',
    files: src(`${PKGS}/domain-index`),
    allowedSavoire: [],
  },
  {
    label: 'domain-sync — leaf',
    files: src(`${PKGS}/domain-sync`),
    allowedSavoire: [],
  },
  {
    label: 'ui-components — leaf',
    files: src(`${PKGS}/ui-components`),
    allowedSavoire: [],
  },
  {
    label: 'i18n — leaf',
    files: src(`${PKGS}/i18n`),
    allowedSavoire: [],
  },
  {
    label: 'notifications — leaf',
    files: src(`${PKGS}/notifications`),
    allowedSavoire: [],
  },

  // ── plugin-api — only domain-index ────────────────────────────────────────
  {
    label: 'plugin-api — only domain-index',
    files: src(`${PKGS}/plugin-api`),
    allowedSavoire: [pkg('domain-index')],
  },

  // ── platform ──────────────────────────────────────────────────────────────
  {
    label: 'platform — only plugin-api, domain-index',
    files: src(`${PKGS}/platform`),
    allowedSavoire: [pkg('plugin-api'), pkg('domain-index')],
  },

  // ── application — no infra libs ───────────────────────────────────────────
  {
    label: 'application — only plugin-api, platform, domain-index; no SignalR/Yjs',
    files: src(`${PKGS}/application`),
    allowedSavoire: [pkg('plugin-api'), pkg('platform'), pkg('domain-index')],
    bannedNpm: [
      { prefix: '@microsoft/signalr', message: 'Use ITransport port.' },
      { prefix: 'yjs',               message: 'Use ICRDT port.' },
    ],
  },

  // ── infrastructure-sync ───────────────────────────────────────────────────
  {
    label: 'infrastructure-sync — only application, domain-sync, domain-index, platform, plugin-api',
    files: src(`${PKGS}/infrastructure-sync`),
    allowedSavoire: [
      pkg('application'), pkg('domain-sync'), pkg('domain-index'),
      pkg('platform'), pkg('plugin-api'),
    ],
  },

  // ── plugin-runtime ────────────────────────────────────────────────────────
  {
    label: 'plugin-runtime — only plugin-api',
    files: src(`${PKGS}/plugin-runtime`),
    allowedSavoire: [pkg('plugin-api')],
  },

  // ── editor-core — only plugin-api; no Yjs / SignalR ──────────────────────
  {
    label: 'editor-core — only plugin-api, i18n; no Yjs/SignalR',
    files: src(`${PKGS}/editor-core`),
    allowedSavoire: [pkg('plugin-api'), pkg('i18n')],
    bannedNpm: [
      { prefix: 'yjs',                   message: 'Use ICRDT port (plugin-api).' },
      { prefix: 'y-codemirror',           message: 'Use ICRDT.getExtensions().' },
      { prefix: 'y-protocols',            message: 'Use ICRDT port (plugin-api).' },
      { prefix: '@microsoft/signalr',     message: 'Use ITransport port (plugin-api).' },
    ],
  },

  // ── editor-react ──────────────────────────────────────────────────────────
  {
    label: 'editor-react — only editor-core, plugin-api',
    files: src(`${PKGS}/editor-react`),
    allowedSavoire: [pkg('editor-core'), pkg('plugin-api')],
  },

  // ── workspace ─────────────────────────────────────────────────────────────
  {
    label: 'workspace — only plugin-api, i18n',
    files: src(`${PKGS}/workspace`),
    allowedSavoire: [pkg('plugin-api'), pkg('i18n')],
  },

  // ── module-bridge ─────────────────────────────────────────────────────────
  {
    label: 'module-bridge — only plugin-api',
    files: src(`${PKGS}/module-bridge`),
    allowedSavoire: [pkg('plugin-api')],
  },

  // ── plugins/* ─────────────────────────────────────────────────────────────
  ...pluginDirs
    .filter(name => name !== 'plugin-module')
    .map(name => ({
      label: `plugins/${name} — only plugin-api`,
      files: src(`${PKGS}/plugins/${name}`),
      allowedSavoire: [pkg('plugin-api')],
    })),
  {
    label: 'plugins/plugin-module — only plugin-api, module-bridge',
    files: src(`${PKGS}/plugins/plugin-module`),
    allowedSavoire: [pkg('plugin-api'), pkg('module-bridge')],
  },

  // ── apps/web — must not import ./api directly ─────────────────────────────
  {
    label: 'apps/web — pages must not import ./api directly (use app-layer service)',
    files: src(`${APPS}/web`)
      .filter(f => !/\/api\.ts$/.test(f) && !/(createWebAppRoot)\.ts$/.test(f)),
    bannedRelativeBasenames: [
      { name: 'api', message: 'Use an app-layer service (ISharingAPI, IDocumentsAPI…) instead.' },
    ],
  },

  // ── apps — must not bypass application layer ──────────────────────────────
  {
    label: 'apps — must not import domain-sync directly',
    files: [
      ...src(`${APPS}/web`),
      ...src(`${APPS}/desktop`),
      ...src(`${APPS}/view`),
    ],
    bannedSavoire: [pkg('domain-sync')],
  },
  {
    label: 'apps — must not import infrastructure-sync (except composition roots)',
    files: [
      ...src(`${APPS}/web`),
      ...src(`${APPS}/desktop`),
      ...src(`${APPS}/view`),
    ].filter(f => !/(createWebAppRoot|createViewRoot|createDesktopRoot)\.ts$/.test(f)),
    bannedSavoire: [pkg('infrastructure-sync')],
  },
]

// ── Engine ────────────────────────────────────────────────────────────────────

let violations = 0

for (const rule of RULES) {
  for (const file of rule.files) {
    const label = relative(ROOT, file)
    let imports
    try {
      imports = extractImports(file)
    } catch {
      continue
    }

    for (const imp of imports) {
      // Allowed @savoire/* list (whitelist mode)
      if (rule.allowedSavoire !== undefined && imp.startsWith('@savoire/')) {
        const allowed = rule.allowedSavoire.some(a => imp === a || imp.startsWith(a + '/'))
        if (!allowed) {
          console.error(`  ✖ ${label}\n    imports "${imp}"\n    rule: ${rule.label}`)
          violations++
        }
      }

      // Banned @savoire/* (blacklist mode, for apps)
      if (rule.bannedSavoire !== undefined) {
        const banned = rule.bannedSavoire.find(a => imp === a || imp.startsWith(a + '/'))
        if (banned) {
          console.error(`  ✖ ${label}\n    imports "${banned}"\n    rule: ${rule.label}`)
          violations++
        }
      }

      // Banned npm prefixes
      for (const ban of rule.bannedNpm ?? []) {
        if (imp === ban.prefix || imp.startsWith(ban.prefix + '/') || imp.startsWith(ban.prefix + '@')) {
          console.error(`  ✖ ${label}\n    imports "${imp}" — ${ban.message}\n    rule: ${rule.label}`)
          violations++
        }
      }

      // Banned relative imports by filename
      for (const ban of rule.bannedRelativeBasenames ?? []) {
        if (imp.startsWith('.') && basename(imp) === ban.name) {
          console.error(`  ✖ ${label}\n    imports "${imp}" — ${ban.message}\n    rule: ${rule.label}`)
          violations++
        }
      }
    }
  }
}

if (violations === 0) {
  console.log('✔ no import boundary violations found')
  process.exit(0)
} else {
  console.error(`\n${violations} violation(s) found`)
  process.exit(1)
}
