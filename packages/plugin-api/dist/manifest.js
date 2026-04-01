// ─── Note scope ────────────────────────────────────────────────────────────
//
// A note can declare plugins in its frontmatter to activate them for that note only.
// Format in frontmatter:
//   plugins: plugin-table:auto, plugin-chart:lazy
//
// 'auto'  → plugin loads when the note opens (default)
// 'lazy'  → plugin loads deferred (requestIdleCallback / after first paint)
//           Use for heavy plugins (large bundles) that are not needed immediately.
export {};
//# sourceMappingURL=manifest.js.map