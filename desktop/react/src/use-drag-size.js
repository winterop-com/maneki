// One pointer-drag for every resizable edge in the app: the video list
// splitter, the spectrum band height and the track-table column grips.
//
// The drag follows the pointer through pointer capture, so leaving the
// handle's few pixels mid-drag does not drop it. The size is written by
// `apply` at most once per animation frame -- a render per pointer event
// leaves the edge visibly behind the hand -- and `commit` runs once on
// release (or after a key press) for persistence.
//
// `start(event)` is called on pointer-down / key-down and returns the
// current size plus its bounds: `{ value, min, max }`. Bounds are read
// per drag rather than fixed so a handle can size itself to the pane it
// lives in. `grows` flips the direction for a handle that sits on the
// far side of the thing it resizes.
//
// Every handle is a `role="separator"` with aria-valuenow and takes
// focus, so an edge that can be dragged can also be nudged with the
// arrow keys (`step` px per press) by someone without a pointer.
import React from "react";

export function useDragSize({ axis = "x", grows = 1, start, apply, commit, step = 16 }) {
  const { useCallback, useRef, useState } = React;
  const [aria, setAria] = useState(null);
  const [dragging, setDragging] = useState(false);
  const frame = useRef(0);

  const clamp = (v, min, max) => Math.round(Math.min(max, Math.max(min, v)));

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const bounds = start(e);
    if (!bounds) return;
    const { min, max } = bounds;
    const origin = axis === "x" ? e.clientX : e.clientY;
    const startValue = bounds.value;
    let last = clamp(startValue, min, max);
    const handle = e.currentTarget;
    try { handle.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    setDragging(true);
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev) => {
      const delta = (axis === "x" ? ev.clientX : ev.clientY) - origin;
      last = clamp(startValue + grows * delta, min, max);
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        apply(last);
      });
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setDragging(false);
      apply(last);
      if (commit) commit(last);
      setAria({ value: last, min, max });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, [axis, grows, start, apply, commit]);

  const onKeyDown = useCallback((e) => {
    const keys = axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    const i = keys.indexOf(e.key);
    if (i < 0) return;
    e.preventDefault();
    const bounds = start(e);
    if (!bounds) return;
    const { min, max } = bounds;
    const next = clamp(bounds.value + grows * (i === 0 ? -step : step), min, max);
    apply(next);
    if (commit) commit(next);
    setAria({ value: next, min, max });
  }, [axis, grows, start, apply, commit, step]);

  return {
    dragging,
    handleProps: {
      role: "separator",
      tabIndex: 0,
      "aria-orientation": axis === "x" ? "vertical" : "horizontal",
      "aria-valuenow": aria?.value,
      "aria-valuemin": aria?.min,
      "aria-valuemax": aria?.max,
      "data-dragging": dragging ? "true" : undefined,
      onPointerDown,
      onKeyDown,
    },
  };
}
