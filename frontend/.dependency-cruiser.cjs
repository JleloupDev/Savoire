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
//     ↓ must NOT import infrastructure-sync or domain-sync directly
//   editor-react
//     ↓ editor-core, plugin-api
//   editor-core
//     ↓ plugin-api ONLY (not plugin-runtime)
//   plugin-runtime
//     ↓ plugin-api
//   workspace, module-bridge, ui-components
//     ↓ plugin-api, i18n (ui-components: nothing)
//   infrastructure-sync
//     ↓ application, domain-sync, platform
//   application
//     ↓ platform, plugin-api
//   platform
//     ↓ plugin-api
//   plugins/* (except plugin-runtime)
//     ↓ plugin-api (plugin-module also module-bridge)
//   plugin-api, domain-sync, ui-components, i18n, notifications
//     ↓ (nothing — leaves)
// ═══════════════════════════════════════════════════════════════════════════

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  // Boundary rules (@savoire/* cross-package + npm imports) are enforced by
  // arch-check-imports.mjs — run via `pnpm arch:check:imports`.
  // This file handles only circular dependency detection and graph generation.
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are forbidden.',
      from: {},
      to: { circular: true },
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
