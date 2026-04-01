import { type ReactNode } from 'react';
export interface DropdownItem {
    label: string;
    onClick(): void;
    disabled?: boolean;
}
export interface DropdownProps {
    trigger: ReactNode;
    items: DropdownItem[];
}
export declare function Dropdown({ trigger, items }: DropdownProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=Dropdown.d.ts.map