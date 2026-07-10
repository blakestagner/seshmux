'use client';
import { useCallback, useRef } from 'react';

// A generic pointer-drag hook for horizontal resize handles.
// - onDrag(deltaX) is called on each pointermove with the x-delta from drag start.
// - onDragEnd() called on pointerup/cancel.
// Uses setPointerCapture so the drag survives crossing an xterm canvas/iframe.
// Returns handlers to spread onto the handle element: { onPointerDown }.
export function useDragResize(opts: {
  onDragStart?: () => void;
  onDrag: (deltaX: number, startX: number, currentX: number) => void;
  onDragEnd?: () => void;
}): { onPointerDown: (e: React.PointerEvent) => void } {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const startXRef = useRef(0);
  const latestXRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    startXRef.current = e.clientX;
    latestXRef.current = e.clientX;
    target.setPointerCapture(pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    optsRef.current.onDragStart?.();

    function runFrame() {
      rafRef.current = null;
      optsRef.current.onDrag(latestXRef.current - startXRef.current, startXRef.current, latestXRef.current);
    }

    function onPointerMove(ev: PointerEvent) {
      latestXRef.current = ev.clientX;
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(runFrame);
    }

    function cleanup() {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      target.removeEventListener('pointermove', onPointerMove);
      target.removeEventListener('pointerup', onPointerUp);
      target.removeEventListener('pointercancel', onPointerUp);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      optsRef.current.onDragEnd?.();
    }

    function onPointerUp() {
      cleanup();
    }

    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointercancel', onPointerUp);
  }, []);

  return { onPointerDown };
}
