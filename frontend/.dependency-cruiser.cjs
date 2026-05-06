// ═══════════════════════════════════════════════════════════════════════════
// dependency-cruiser — PROTECTED FILE
//
// Do NOT modify this file without an explicit request from the user.
// It encodes the architecture constraints of the frontend monorepo and acts
// as an automated guard against inter-package dependency violations.
//
// Strict hierarchy (a layer may only import from layers below it):
//
//   apps (web, view, desktop, editor-dev)
//     ↓ may import anything
//   editor-react
//     ↓ editor-core, plugin-api
//   editor-core
//     ↓ plugin-api ONLY (not plugin-runtime)
//   plugin-runtime
//     ↓ plugin-api
//   workspace, module-bridge, ui-components
//     ↓ plugin-api (ui-components: nothing)
//   infrastructure-sync
//     ↓ application, domain-sync, platform
//   application
//     ↓ platform, plugin-api
//   platform
//     ↓ plugin-api
//   plugins/* (except plugin-runtime)
//     ↓ plugin-api (plugin-module also module-bridge)
//   plugin-api, domain-sync, ui-components
//     ↓ (nothing — leaves)
// ═══════════════════════════════════════════════════════════════════════════

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [

    // ── General rules ──────────────────────────────────────────────────────

    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are forbidden.',
      from: {},
      to: { circular: true },
    },

    // ── domain-index — absolute leaf ───────────────────────────────────────

    {
      name: 'domain-index-no-cross-package-imports',
      severity: 'error',
      comment: 'domain-index is an absolute leaf — no dependencies on other @savoire packages.',
      from: { path: '^packages/domain-index/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/domain-index/',
      },
    },

    // ── plugin-api — may only import from domain-index ─────────────────────

    {
      name: 'plugin-api-no-cross-package-imports',
      severity: 'error',
      comment: 'plugin-api may only import from domain-index.',
      from: { path: '^packages/plugin-api/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|domain-index)/',
      },
    },

    // ── domain-sync — leaf ─────────────────────────────────────────────────

    {
      name: 'domain-sync-no-cross-package-imports',
      severity: 'error',
      comment: 'domain-sync is a leaf — no dependencies on other @savoire packages.',
      from: { path: '^packages/domain-sync/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/domain-sync/',
      },
    },

    // ── ui-components — leaf ───────────────────────────────────────────────

    {
      name: 'ui-components-no-cross-package-imports',
      severity: 'error',
      comment: 'ui-components is a leaf — no dependencies on other @savoire packages.',
      from: { path: '^packages/ui-components/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/ui-components/',
      },
    },

    // ── platform — plugin-api and domain-index ─────────────────────────────

    {
      name: 'platform-only-plugin-api-and-domain-index',
      severity: 'error',
      comment: 'platform may only import from plugin-api and domain-index.',
      from: { path: '^packages/platform/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|domain-index|platform)/',
      },
    },

    // ── application — plugin-api, platform and domain-index ────────────────

    {
      name: 'application-only-plugin-api-platform-domain-index',
      severity: 'error',
      comment: 'application may only import from plugin-api, platform and domain-index.',
      from: { path: '^packages/application/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|platform|domain-index|application)/',
      },
    },

    // ── infrastructure-sync — application, domain-sync, platform, domain-index

    {
      name: 'infrastructure-sync-allowed-deps',
      severity: 'error',
      comment: 'infrastructure-sync may only import from application, domain-sync, platform, domain-index and plugin-api.',
      from: { path: '^packages/infrastructure-sync/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(application|domain-sync|domain-index|platform|plugin-api|infrastructure-sync)/',
      },
    },

    // ── plugin-runtime — plugin-api only ───────────────────────────────────

    {
      name: 'plugin-runtime-only-plugin-api',
      severity: 'error',
      comment: 'plugin-runtime may only import from plugin-api.',
      from: { path: '^packages/plugin-runtime/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|plugin-runtime)/',
      },
    },

    // ── editor-core — plugin-api only (not plugin-runtime!) ────────────────

    {
      name: 'editor-core-no-plugin-runtime',
      severity: 'error',
      comment: 'editor-core must NOT import from plugin-runtime. Use IPluginLoader/IEditorHostAPI from plugin-api.',
      from: { path: '^packages/editor-core/src' },
      to: { path: '^packages/plugin-runtime/' },
    },
    {
      name: 'editor-core-only-plugin-api',
      severity: 'error',
      comment: 'editor-core may only import from plugin-api (and its own files).',
      from: { path: '^packages/editor-core/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|editor-core)/',
      },
    },

    // ── editor-react — editor-core and plugin-api only ─────────────────────

    {
      name: 'editor-react-allowed-deps',
      severity: 'error',
      comment: 'editor-react may only import from editor-core and plugin-api.',
      from: { path: '^packages/editor-react/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(editor-core|plugin-api|editor-react)/',
      },
    },

    // ── workspace — plugin-api only ────────────────────────────────────────

    {
      name: 'workspace-only-plugin-api',
      severity: 'error',
      comment: 'workspace may only import from plugin-api.',
      from: { path: '^packages/workspace/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|workspace)/',
      },
    },

    // ── module-bridge — plugin-api only ────────────────────────────────────

    {
      name: 'module-bridge-only-plugin-api',
      severity: 'error',
      comment: 'module-bridge may only import from plugin-api.',
      from: { path: '^packages/module-bridge/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|module-bridge)/',
      },
    },

    // ── plugins/* (except plugin-runtime) — plugin-api only ────────────────

    {
      name: 'plugins-only-plugin-api',
      severity: 'error',
      comment: 'Plugins may only import from plugin-api (intra-plugin imports allowed).',
      from: {
        path: '^packages/plugins/(?!(plugin-module|plugin-runtime))',
      },
      to: {
        path: '^packages/',
        // Allow plugin-api and intra-plugin imports (same plugin folder)
        pathNot: '^packages/(plugin-api|plugins/)',
      },
    },
    {
      name: 'plugin-module-allowed-deps',
      severity: 'error',
      comment: 'plugin-module may only import from plugin-api and module-bridge.',
      from: { path: '^packages/plugins/plugin-module/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|module-bridge|plugins/plugin-module)/',
      },
    },
  ],

  options: {
    doNotFollow: {
      dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled'],
    },
    exclude: {
      path: '(dist|node_modules|coverage)/',
    },
    moduleSystems: ['es6', 'cjs'],
    // tsPreCompilationDeps is too memory-intensive on large scans — disabled.
    // Architecture rules apply to module imports, not type-level dependencies.
    tsPreCompilationDeps: false,
    tsConfig: { fileName: 'tsconfig.base.json' },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
