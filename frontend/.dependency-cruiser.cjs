// ═══════════════════════════════════════════════════════════════════════════
// dependency-cruiser — FICHIER PROTÉGÉ
//
// Ce fichier ne doit PAS être modifié sans demande explicite de l'utilisateur.
// Il encode les contraintes d'architecture du monorepo frontend et sert de
// garde-fou automatique contre les violations de dépendances inter-packages.
//
// Hiérarchie stricte (une couche ne peut importer que depuis les couches inférieures) :
//
//   apps (web, view, desktop, editor-dev)
//     ↓ peuvent tout importer
//   editor-react
//     ↓ editor-core, plugin-api
//   editor-core
//     ↓ plugin-api UNIQUEMENT (pas plugin-runtime)
//   plugin-runtime
//     ↓ plugin-api
//   workspace, module-bridge, ui-components
//     ↓ plugin-api (ui-components: rien)
//   infrastructure-sync
//     ↓ application, domain-sync, platform
//   application
//     ↓ platform, plugin-api
//   platform
//     ↓ plugin-api
//   plugins/* (sauf plugin-runtime)
//     ↓ plugin-api (plugin-module aussi module-bridge)
//   plugin-api, domain-sync, ui-components
//     ↓ (rien — feuilles)
// ═══════════════════════════════════════════════════════════════════════════

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [

    // ── Règles générales ───────────────────────────────────────────────────

    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Les dépendances circulaires sont interdites.',
      from: {},
      to: { circular: true },
    },

    // ── plugin-api — feuille absolue ────────────────────────────────────────

    {
      name: 'plugin-api-no-cross-package-imports',
      severity: 'error',
      comment: 'plugin-api ne doit importer aucun autre package @poc.',
      from: { path: '^packages/plugin-api/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/plugin-api/',
      },
    },

    // ── domain-sync — feuille ───────────────────────────────────────────────

    {
      name: 'domain-sync-no-cross-package-imports',
      severity: 'error',
      comment: 'domain-sync est une feuille — aucune dépendance vers d\'autres packages @poc.',
      from: { path: '^packages/domain-sync/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/domain-sync/',
      },
    },

    // ── ui-components — feuille ─────────────────────────────────────────────

    {
      name: 'ui-components-no-cross-package-imports',
      severity: 'error',
      comment: 'ui-components est une feuille — aucune dépendance vers d\'autres packages @poc.',
      from: { path: '^packages/ui-components/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/ui-components/',
      },
    },

    // ── platform — uniquement plugin-api ────────────────────────────────────

    {
      name: 'platform-only-plugin-api',
      severity: 'error',
      comment: 'platform ne peut importer que depuis plugin-api.',
      from: { path: '^packages/platform/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|platform)/',
      },
    },

    // ── application — uniquement plugin-api et platform ─────────────────────

    {
      name: 'application-only-plugin-api-and-platform',
      severity: 'error',
      comment: 'application ne peut importer que depuis plugin-api et platform.',
      from: { path: '^packages/application/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|platform|application)/',
      },
    },

    // ── infrastructure-sync — uniquement application, domain-sync, platform ──

    {
      name: 'infrastructure-sync-allowed-deps',
      severity: 'error',
      comment: 'infrastructure-sync ne peut importer que depuis application, domain-sync et platform.',
      from: { path: '^packages/infrastructure-sync/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(application|domain-sync|platform|plugin-api|infrastructure-sync)/',
      },
    },

    // ── plugin-runtime — uniquement plugin-api ──────────────────────────────

    {
      name: 'plugin-runtime-only-plugin-api',
      severity: 'error',
      comment: 'plugin-runtime ne peut importer que depuis plugin-api.',
      from: { path: '^packages/plugin-runtime/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|plugin-runtime)/',
      },
    },

    // ── editor-core — uniquement plugin-api (pas plugin-runtime!) ───────────

    {
      name: 'editor-core-no-plugin-runtime',
      severity: 'error',
      comment: 'editor-core ne doit PAS importer depuis plugin-runtime. Utiliser IPluginLoader/IEditorHostAPI depuis plugin-api.',
      from: { path: '^packages/editor-core/src' },
      to: { path: '^packages/plugin-runtime/' },
    },
    {
      name: 'editor-core-only-plugin-api',
      severity: 'error',
      comment: 'editor-core ne peut importer que depuis plugin-api (et ses propres fichiers).',
      from: { path: '^packages/editor-core/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|editor-core)/',
      },
    },

    // ── editor-react — uniquement editor-core et plugin-api ─────────────────

    {
      name: 'editor-react-allowed-deps',
      severity: 'error',
      comment: 'editor-react ne peut importer que depuis editor-core et plugin-api.',
      from: { path: '^packages/editor-react/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(editor-core|plugin-api|editor-react)/',
      },
    },

    // ── workspace — uniquement plugin-api ───────────────────────────────────

    {
      name: 'workspace-only-plugin-api',
      severity: 'error',
      comment: 'workspace ne peut importer que depuis plugin-api.',
      from: { path: '^packages/workspace/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|workspace)/',
      },
    },

    // ── module-bridge — uniquement plugin-api ───────────────────────────────

    {
      name: 'module-bridge-only-plugin-api',
      severity: 'error',
      comment: 'module-bridge ne peut importer que depuis plugin-api.',
      from: { path: '^packages/module-bridge/src' },
      to: {
        path: '^packages/',
        pathNot: '^packages/(plugin-api|module-bridge)/',
      },
    },

    // ── plugins/* (hors plugin-runtime) — uniquement plugin-api ─────────────

    {
      name: 'plugins-only-plugin-api',
      severity: 'error',
      comment: 'Les plugins ne peuvent importer que depuis plugin-api (imports intra-plugin autorisés).',
      from: {
        path: '^packages/plugins/(?!(plugin-module|plugin-runtime))',
      },
      to: {
        path: '^packages/',
        // Autoriser plugin-api et les imports intra-plugin (même dossier plugin)
        pathNot: '^packages/(plugin-api|plugins/)',
      },
    },
    {
      name: 'plugin-module-allowed-deps',
      severity: 'error',
      comment: 'plugin-module peut importer depuis plugin-api et module-bridge uniquement.',
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
    // tsPreCompilationDeps trop coûteux en mémoire sur de grands scans — désactivé.
    // Les règles d'architecture portent sur les imports de modules, pas les types.
    tsPreCompilationDeps: false,
    tsConfig: { fileName: 'tsconfig.base.json' },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
