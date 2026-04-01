import * as Y from 'yjs';
export class YjsCollabDocumentEngine {
    doc;
    text;
    constructor(initialText = '') {
        this.doc = new Y.Doc();
        this.text = this.doc.getText('content');
        if (initialText)
            this.text.insert(0, initialText);
    }
    applyLocal(payload) {
        Y.applyUpdate(this.doc, payload);
        return { text: this.text.toString(), versionDelta: 1 };
    }
    applyRemote(payload) {
        Y.applyUpdate(this.doc, payload);
        return { text: this.text.toString(), versionDelta: 1 };
    }
    getText() {
        return this.text.toString();
    }
}
//# sourceMappingURL=YjsCollabDocumentEngine.js.map