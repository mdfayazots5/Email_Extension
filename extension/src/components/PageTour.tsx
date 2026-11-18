import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { TourStep } from "../guide/guide-content";

type PageTourProps = {
  steps: TourStep[];
  onDone: () => void;
};

type Box = { top: number; left: number; width: number; height: number };

const PAD = 6;
const POPOVER_WIDTH = 300;

function findTarget(target: string): HTMLElement | null {
  const element = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (!element || element.closest("[hidden]") || getComputedStyle(element).display === "none") return null;
  return element;
}

/** Spotlight tour: highlights one part of the page at a time with Back / Next. */
export function PageTour({ steps, onDone }: PageTourProps) {
  const available = useMemo(() => steps.filter((step) => findTarget(step.target)), [steps]);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const step = available[index];

  const measure = useCallback(() => {
    if (!step) return;
    const element = findTarget(step.target);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setBox({ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 });
  }, [step]);

  useLayoutEffect(() => {
    if (!step) return;
    findTarget(step.target)?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    measure();
    const timer = window.setTimeout(measure, 350);
    return () => window.clearTimeout(timer);
  }, [step, measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onDone(); };
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("keydown", handleKey);
    };
  }, [measure, onDone]);

  useEffect(() => {
    if (available.length === 0) onDone();
  }, [available.length, onDone]);

  if (!step) return null;
  const last = index === available.length - 1;

  const viewportWidth = window.innerWidth || 1024;
  const viewportHeight = window.innerHeight || 768;
  const width = Math.min(POPOVER_WIDTH, viewportWidth - 32);
  let popoverStyle: React.CSSProperties = { width, left: 16, top: 16 };
  if (box) {
    const below = box.top + box.height + 12;
    const fitsBelow = below + 170 < viewportHeight;
    popoverStyle = {
      width,
      left: Math.max(16, Math.min(box.left, viewportWidth - width - 16)),
      top: fitsBelow ? below : Math.max(16, box.top - 12 - 170)
    };
  }

  return (
    <div className="page-tour" role="presentation">
      {box && <div className="page-tour-spot" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />}
      <section className="page-tour-pop" role="dialog" aria-modal="false" aria-labelledby="page-tour-title" style={popoverStyle}>
        <small className="page-tour-count">{index + 1} of {available.length}</small>
        <h2 id="page-tour-title">{step.title}</h2>
        <p>{step.body}</p>
        <div className="page-tour-actions">
          <button className="page-tour-skip" type="button" onClick={onDone}>Skip</button>
          <span />
          {index > 0 && <button className="button button--secondary button--small" type="button" onClick={() => setIndex(index - 1)}>Back</button>}
          <button className="button button--primary button--small" type="button" autoFocus onClick={() => (last ? onDone() : setIndex(index + 1))}>{last ? "Done" : "Next"}</button>
        </div>
      </section>
    </div>
  );
}
