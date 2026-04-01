import type { ReactNode } from 'react';
export interface ModalProps {
    open: boolean;
    title?: string;
    onClose(): void;
    children: ReactNode;
}
export declare function Modal({ open, title, onClose, children }: ModalProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=Modal.d.ts.map