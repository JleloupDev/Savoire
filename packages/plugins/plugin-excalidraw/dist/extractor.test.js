// Tests unitaires — excalidrawContentExtractor
// La logique est pure (JSON parsing), pas de dépendance DOM ni React.
import { describe, it, expect } from 'vitest';
import { excalidrawContentExtractor } from './content-extractor';
const extractor = excalidrawContentExtractor;
describe('excalidrawContentExtractor.toShadowDocument', () => {
    it('returns empty string for empty scene', () => {
        const json = JSON.stringify({ elements: [], appState: {}, files: {} });
        expect(extractor.toShadowDocument(json)).toBe('');
    });
    it('extracts text from text elements', () => {
        const json = JSON.stringify({
            elements: [
                { type: 'text', text: 'Hello world' },
                { type: 'text', text: 'Second line' },
            ],
        });
        const result = extractor.toShadowDocument(json);
        expect(result).toContain('Hello world');
        expect(result).toContain('Second line');
    });
    it('ignores non-text elements (rectangle, arrow, etc.)', () => {
        const json = JSON.stringify({
            elements: [
                { type: 'rectangle', x: 0, y: 0 },
                { type: 'arrow', x: 0, y: 0 },
                { type: 'text', text: 'visible' },
            ],
        });
        const result = extractor.toShadowDocument(json);
        expect(result).toBe('visible');
    });
    it('ignores text elements with empty or whitespace-only text', () => {
        const json = JSON.stringify({
            elements: [
                { type: 'text', text: '   ' },
                { type: 'text', text: '' },
                { type: 'text', text: 'real content' },
            ],
        });
        const result = extractor.toShadowDocument(json);
        expect(result).toBe('real content');
    });
    it('joins multiple text elements with double newline', () => {
        const json = JSON.stringify({
            elements: [
                { type: 'text', text: 'First' },
                { type: 'text', text: 'Second' },
            ],
        });
        expect(extractor.toShadowDocument(json)).toBe('First\n\nSecond');
    });
    it('returns empty string for invalid JSON', () => {
        expect(extractor.toShadowDocument('not-json')).toBe('');
    });
    it('returns empty string for empty string input', () => {
        expect(extractor.toShadowDocument('')).toBe('');
    });
    it('handles scene with no elements key', () => {
        const json = JSON.stringify({ appState: {} });
        expect(extractor.toShadowDocument(json)).toBe('');
    });
    it('trims whitespace from individual text elements', () => {
        const json = JSON.stringify({
            elements: [{ type: 'text', text: '  padded  ' }],
        });
        expect(extractor.toShadowDocument(json)).toBe('padded');
    });
});
//# sourceMappingURL=extractor.test.js.map