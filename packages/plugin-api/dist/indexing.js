// ─── Content extraction (shadow documents) ──────────────────────────────
//
// Un plugin qui gère un type de fichier non-Markdown peut déclarer un ContentExtractor
// pour produire un document shadow Markdown indexable.
// L'extracteur est isomorphique : il fonctionne côté client ET côté serveur (Node).
//
// Usage dans un plugin FileTypeSpec :
//   contentExtractor: {
//     toShadowDocument(rawContent: string): string { ... }
//   }
export {};
//# sourceMappingURL=indexing.js.map