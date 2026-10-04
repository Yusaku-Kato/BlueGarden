import { useEffect, useRef, useState, type RefObject } from "react";
import type { DisplayError } from "../app/displayErrors";
import { RENDER } from "../config/gardenConfig";
import type { RendererKind, RenderSettings } from "../domain/models";
import { errorName, logger } from "../infra/logger";
import { loadRenderer } from "../rendering/loadRenderer";
import type { TerrariumRenderer } from "../rendering/TerrariumRenderer";

export interface TerrariumOptions {
  /** Requested renderer. A 3D init failure falls back to 2D for this run only (the setting is untouched). */
  readonly renderer: RendererKind;
  readonly dimmed: boolean;
  /** Stops rendering and plant aging (window hidden or minimized). */
  readonly paused: boolean;
  /** Applied after init and on every change. */
  readonly renderSettings: RenderSettings;
}

export interface TerrariumState {
  /** Set only after init succeeded; null while (re)creating. */
  readonly engine: TerrariumRenderer | null;
  readonly renderError: DisplayError | null;
  /** The renderer actually running (differs from the requested one after a fallback). */
  readonly activeRenderer: RendererKind;
}

/** Recoveries count as consecutive unless the engine ran this long without losing its context. */
const STABLE_AFTER_MS = 30_000;
/** Delay before retrying an engine re-init that failed during context-loss recovery. */
const RECOVERY_RETRY_DELAY_MS = 2_000;

const INIT_FAILED: DisplayError = { source: "render", kind: "initFailed" };
const CONTEXT_LOST: DisplayError = { source: "render", kind: "contextLost" };
const FELL_BACK_TO_2D: DisplayError = { source: "render", kind: "fallback2d" };

interface KindedError {
  readonly error: DisplayError;
  /** The renderer kind the error belongs to; stale after the kind changes. */
  readonly forKind: RendererKind;
}

/**
 * Creates, initializes and destroys the renderer (docs/DESIGN.md sections 13.3, 35.2).
 * Every effect run owns a brand-new instance, so StrictMode double-mount is safe. Changing the
 * renderer kind re-runs the effect: the old instance is destroyed before the new one is created.
 */
export function useTerrarium(
  hostRef: RefObject<HTMLDivElement | null>,
  options: TerrariumOptions,
): TerrariumState {
  const [engine, setEngine] = useState<TerrariumRenderer | null>(null);
  const [errorState, setErrorState] = useState<KindedError | null>(null);
  const [generation, setGeneration] = useState(0);
  /** The requested kind whose 3D initialization failed; it runs as 2D until the request changes. */
  const [fellBackFrom, setFellBackFrom] = useState<RendererKind | null>(null);
  const recoveriesRef = useRef(0);
  const { dimmed, paused, renderSettings, renderer } = options;
  // A new request clears an earlier fallback (adjusting state while rendering, per React docs).
  const [requestedRenderer, setRequestedRenderer] = useState(renderer);
  if (requestedRenderer !== renderer) {
    setRequestedRenderer(renderer);
    setFellBackFrom(null);
  }
  const activeRenderer: RendererKind = fellBackFrom === renderer ? "pixi2d" : renderer;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;
    const mock: { stop: (() => void) | null } = { stop: null };
    let stableTimer: ReturnType<typeof setTimeout> | null = null;

    const kind = activeRenderer;
    let instance: TerrariumRenderer | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    loadRenderer(kind)
      .then((factory) => {
        if (cancelled) return null;
        const created = factory({
          onContextLost: () => {
            if (cancelled) return;
            logger.error("render.contextLost");
            if (recoveriesRef.current >= RENDER.MAX_CONTEXT_RECOVERIES) {
              setErrorState({ error: CONTEXT_LOST, forKind: kind });
              return;
            }
            recoveriesRef.current += 1;
            setGeneration((value) => value + 1);
          },
        });
        instance = created;
        return created.init(host).then((ok) => (ok ? created : null));
      })
      .then((ready) => {
        if (ready === null || cancelled) return;
        const created = ready;
        setEngine(created);
        // A later successful init for this kind clears its earlier error banner.
        setErrorState((current) => (current !== null && current.forKind === kind ? null : current));
        if (recoveriesRef.current > 0) {
          stableTimer = setTimeout(() => {
            recoveriesRef.current = 0;
          }, STABLE_AFTER_MS);
        }
        if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock")) {
          import("../dev/mockSource")
            .then(({ startMockSource }) => {
              if (isCancelled()) return;
              mock.stop = startMockSource(created);
            })
            .catch((caught: unknown) => {
              logger.warn("dev.mockImportFailed", { error: errorName(caught) });
            });
        }
      })
      .catch((caught: unknown) => {
        logger.error("render.initFailed", { error: errorName(caught) });
        if (cancelled) return;
        // Re-init right after a context loss can fail while the GPU is still resetting:
        // treat it as another recovery attempt instead of a permanent failure.
        const recovering = recoveriesRef.current > 0;
        if (recovering && recoveriesRef.current < RENDER.MAX_CONTEXT_RECOVERIES) {
          recoveriesRef.current += 1;
          retryTimer = setTimeout(() => {
            setGeneration((value) => value + 1);
          }, RECOVERY_RETRY_DELAY_MS);
          return;
        }
        if (kind === "three3d") {
          // Chunk load failure or RenderInitError: show the garden in 2D instead (setting untouched).
          instance?.destroy();
          instance = null;
          recoveriesRef.current = 0;
          setFellBackFrom(kind);
          return;
        }
        setErrorState({ error: recovering ? CONTEXT_LOST : INIT_FAILED, forKind: kind });
      });

    return () => {
      cancelled = true;
      if (stableTimer !== null) clearTimeout(stableTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      mock.stop?.();
      setEngine(null);
      instance?.destroy();
    };
  }, [hostRef, generation, activeRenderer]);

  useEffect(() => {
    engine?.applySettings(renderSettings);
  }, [engine, renderSettings]);

  useEffect(() => {
    engine?.setDimmed(dimmed);
  }, [engine, dimmed]);

  useEffect(() => {
    engine?.setPaused(paused);
  }, [engine, paused]);

  const renderError: DisplayError | null =
    errorState !== null && errorState.forKind === activeRenderer
      ? errorState.error
      : fellBackFrom === renderer
        ? FELL_BACK_TO_2D
        : null;

  return { engine, renderError, activeRenderer };
}
