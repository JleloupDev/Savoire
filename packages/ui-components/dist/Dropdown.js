import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useEffect } from 'react';
export function Dropdown({ trigger, items }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        const handler = (e) => {
            if (ref.current && !ref.current.contains(e.target)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);
    return (_jsxs("div", { ref: ref, style: { position: 'relative', display: 'inline-block' }, children: [_jsx("div", { onClick: () => setOpen((v) => !v), children: trigger }), open && (_jsx("div", { style: {
                    position: 'absolute',
                    top: '100%',
                    left: 0,
                    background: '#fff',
                    border: '1px solid #e0e0e0',
                    borderRadius: 4,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
                    zIndex: 100,
                    minWidth: 160,
                }, children: items.map((item, i) => (_jsx("div", { onClick: () => {
                        if (!item.disabled) {
                            item.onClick();
                            setOpen(false);
                        }
                    }, style: {
                        padding: '6px 12px',
                        cursor: item.disabled ? 'not-allowed' : 'pointer',
                        opacity: item.disabled ? 0.5 : 1,
                        fontSize: 13,
                    }, children: item.label }, i))) }))] }));
}
//# sourceMappingURL=Dropdown.js.map