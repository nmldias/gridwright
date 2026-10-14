// Menus and popovers render here, not where they are declared: one layer appended to <body>,
// outside the canvas host and every panel, so that no ancestor's overflow, transform or
// compositing (a WebGL canvas on a phone browser among them) can put itself above them.

import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

let root: HTMLElement | null = null;
function overlayRoot(): HTMLElement {
  if (root && root.isConnected) return root;
  root = document.getElementById('overlays');
  if (!root) {
    root = document.createElement('div');
    root.id = 'overlays';
    document.body.appendChild(root);
  }
  return root;
}

export function Overlay({ children }: { children: ReactNode }) {
  return createPortal(children, overlayRoot());
}
