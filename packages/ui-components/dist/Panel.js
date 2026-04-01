import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function Panel({ title, children, style }) {
    return (_jsxs("div", { style: {
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid #e0e0e0',
            borderRadius: 4,
            overflow: 'hidden',
            ...style,
        }, children: [title && (_jsx("div", { style: {
                    padding: '6px 12px',
                    borderBottom: '1px solid #e0e0e0',
                    fontWeight: 600,
                    fontSize: 12,
                    background: '#f8f8f8',
                }, children: title })), _jsx("div", { style: { flex: 1, overflow: 'auto', padding: 8 }, children: children })] }));
}
//# sourceMappingURL=Panel.js.map