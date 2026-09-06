import { useEffect } from "react";

export interface VisibleViewport { height: number; offsetTop: number; offsetLeft: number; }
export function visibleViewport(viewport: Pick<VisualViewport, "height" | "offsetTop" | "offsetLeft" | "scale"> | null, fallbackHeight: number): VisibleViewport {
  // Pinch zoom belongs to the browser. Resizing the root while zooming creates
  // layout/scroll feedback, so only track the normal visual viewport.
  if (!viewport || Math.abs(viewport.scale - 1) > 0.01) return { height: fallbackHeight, offsetTop: 0, offsetLeft: 0 };
  return { height: Math.max(1, Math.round(viewport.height)), offsetTop: Math.max(0, Math.round(viewport.offsetTop)), offsetLeft: Math.max(0, Math.round(viewport.offsetLeft)) };
}

export function useVisibleViewport(): void {
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    let previous = "";
    const update = () => {
      frame = 0;
      const viewport = visibleViewport(window.visualViewport, window.innerHeight);
      const key = `${viewport.height}:${viewport.offsetTop}:${viewport.offsetLeft}`;
      if (key === previous) return;
      previous = key;
      root.style.setProperty("--visible-height", `${viewport.height}px`);
      root.style.setProperty("--visible-top", `${viewport.offsetTop}px`);
      root.style.setProperty("--visible-left", `${viewport.offsetLeft}px`);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, []);
}
