'use client';

import { useEffect, useRef, useState } from 'react';

// Shared open/close/click-outside/Escape behavior for the menu-style dropdowns
// (BridgeMenu, AssistMenu). stopPropagation on Escape (not just close) so a
// modal's own window-level Escape listener never sees this keypress — bubble
// order runs document-level listeners before window-level ones regardless of
// registration order, so this is deterministic, not a listener-order race.
// (BridgeMenu previously did not stopPropagation here; adding it is safe —
// there's no modal-level Escape handler that this could now suppress.)
export function useDropdown() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return { open, setOpen, wrapRef };
}
