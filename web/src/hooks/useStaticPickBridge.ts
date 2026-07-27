import { useCallback, useEffect, useRef, useState } from 'react';
import { PanePickResult, applyHoverHighlight, buildDomAnchorPick, clearHoverHighlight, isPickableElement, HoverHighlight } from '../lib/domAnchor';
import { computePickPosition } from '../lib/liveBridge';
import { ViewMode } from '../lib/viewMode';

export interface UseStaticPickBridgeParams<T extends { path: string }> {
  path: string | undefined;
  revision: number;
  viewMode: ViewMode;
  data: T | null;
  iframeRef: React.RefObject<HTMLIFrameElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  onPick: (result: PanePickResult) => void;
}

export interface UseStaticPickBridgeResult {
  armed: boolean;
  setArmed: React.Dispatch<React.SetStateAction<boolean>>;
  toggleArmed: () => void;
  disabled: boolean;
  handleIframeLoad: () => void;
}

type ListenerEntry = [keyof DocumentEventMap, EventListener];

/** Owns static iframe comment-pick mode and its capture-phase document guards. */
export function useStaticPickBridge<T extends { path: string }>({
  path,
  revision,
  viewMode,
  data,
  iframeRef,
  containerRef,
  onPick,
}: UseStaticPickBridgeParams<T>): UseStaticPickBridgeResult {
  const [armed, setArmed] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const armedRef = useRef(armed);
  const dataRef = useRef(data);
  const onPickRef = useRef(onPick);
  const attachedRef = useRef<{ doc: Document; entries: ListenerEntry[] } | null>(null);
  const hoverRef = useRef<HoverHighlight | null>(null);

  useEffect(() => { armedRef.current = armed; }, [armed]);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { onPickRef.current = onPick; }, [onPick]);

  const clearHover = useCallback(() => {
    clearHoverHighlight(hoverRef.current);
    hoverRef.current = null;
  }, []);

  const detach = useCallback(() => {
    const attached = attachedRef.current;
    if (!attached) return;
    for (const [type, handler] of attached.entries) attached.doc.removeEventListener(type, handler, true);
    attachedRef.current = null;
    clearHover();
  }, [clearHover]);

  const attach = useCallback(() => {
    detach();
    let doc: Document | null = null;
    try {
      doc = iframeRef.current?.contentDocument ?? null;
    } catch {
      return;
    }
    if (!doc) return;
    let url = '';
    try {
      url = doc.URL;
    } catch {
      return;
    }
    if (url && url !== 'about:srcdoc') {
      setDisabled(true);
      setArmed(false);
      return;
    }
    if (!url) return;
    setDisabled(false);

    const onClick: EventListener = (event) => {
      if (!armedRef.current) return;
      event.preventDefault();
      if (!isPickableElement(event.target)) return;
      const pick = buildDomAnchorPick(event.target);
      if (!pick) return;
      const iframe = iframeRef.current;
      const container = containerRef.current;
      const currentData = dataRef.current;
      if (!iframe || !container || !currentData) return;
      const { top, left } = computePickPosition(
        container.getBoundingClientRect(),
        iframe.getBoundingClientRect(),
        event.target.getBoundingClientRect()
      );
      clearHover();
      onPickRef.current({ path: currentData.path, top, left, ...pick });
      setArmed(false);
    };
    const prevent = (event: Event) => {
      if (armedRef.current) event.preventDefault();
    };
    const onMouseOver: EventListener = (event) => {
      if (!armedRef.current || !isPickableElement(event.target)) return;
      if (hoverRef.current?.el === event.target) return;
      clearHover();
      hoverRef.current = applyHoverHighlight(event.target);
    };
    const onMouseOut = () => {
      if (armedRef.current) clearHover();
    };
    const entries: ListenerEntry[] = [
      ['click', onClick],
      ['mousedown', prevent],
      ['auxclick', prevent],
      ['contextmenu', prevent],
      ['dragstart', prevent],
      ['submit', prevent],
      ['mouseover', onMouseOver],
      ['mouseout', onMouseOut],
    ];
    for (const [type, handler] of entries) doc.addEventListener(type, handler, true);
    attachedRef.current = { doc, entries };
  }, [clearHover, containerRef, detach, iframeRef]);

  const toggleArmed = useCallback(() => {
    setArmed((current) => !current);
  }, []);

  useEffect(() => {
    setArmed(false);
  }, [path, revision, viewMode]);

  useEffect(() => {
    if (viewMode !== 'static') detach();
  }, [viewMode, detach]);

  useEffect(() => detach, [detach]);

  useEffect(() => {
    let root: HTMLElement | null = null;
    let cursor = '';
    if (armed) {
      try {
        root = iframeRef.current?.contentDocument?.documentElement ?? null;
        if (root) {
          cursor = root.style.cursor;
          root.style.cursor = 'crosshair';
        }
      } catch {
        // The next load will decide whether this document can be armed.
      }
    } else {
      clearHover();
    }
    return () => {
      if (root) root.style.cursor = cursor;
      clearHover();
    };
  }, [armed, clearHover, iframeRef]);

  return { armed, setArmed, toggleArmed, disabled, handleIframeLoad: attach };
}
