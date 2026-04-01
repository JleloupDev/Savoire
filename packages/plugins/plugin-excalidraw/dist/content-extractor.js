// ContentExtractor isomorphique — pas de dépendance à Excalidraw UI ni DOM.
// Exporté séparément pour permettre les tests unitaires sans charger Excalidraw.
export const excalidrawContentExtractor = {
    toShadowDocument(rawContent) {
        try {
            const parsed = JSON.parse(rawContent);
            const texts = (parsed.elements ?? [])
                .filter(el => el.type === 'text' && typeof el.text === 'string' && el.text.trim())
                .map(el => el.text.trim());
            return texts.length > 0 ? texts.join('\n\n') : '';
        }
        catch {
            return '';
        }
    },
};
//# sourceMappingURL=content-extractor.js.map