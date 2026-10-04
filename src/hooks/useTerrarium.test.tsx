// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererKind, RenderSettings } from "../domain/models";
import { DEFAULT_SETTINGS } from "../domain/settings";
import type { TerrariumState } from "./useTerrarium";

interface FakeEngine {
  readonly kind: "pixi2d" | "three3d";
  readonly options: { onContextLost?: () => void } | undefined;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly setDimmed: ReturnType<typeof vi.fn>;
  readonly setPaused: ReturnType<typeof vi.fn>;
  readonly applySettings: ReturnType<typeof vi.fn>;
  readonly init: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  instances: [] as FakeEngine[],
  initImpl: null as null | (() => Promise<boolean>),
  threeInitImpl: null as null | (() => Promise<boolean>),
}));

vi.mock("../rendering/three/ThreeTerrariumEngine", () => {
  class ThreeTerrariumEngine {
    readonly kind = "three3d" as const;
    readonly options: FakeEngine["options"];
    readonly destroy = vi.fn();
    readonly setDimmed = vi.fn();
    readonly setPaused = vi.fn();
    readonly applySettings = vi.fn();
    readonly init = vi.fn(() => (mocks.threeInitImpl ? mocks.threeInitImpl() : Promise.resolve(true)));
    constructor(options?: FakeEngine["options"]) {
      this.options = options;
      mocks.instances.push(this);
    }
  }
  return { ThreeTerrariumEngine };
});

vi.mock("../rendering/TerrariumEngine", () => {
  class RenderInitError extends Error {}
  class TerrariumEngine {
    readonly kind = "pixi2d" as const;
    readonly options: FakeEngine["options"];
    readonly destroy = vi.fn();
    readonly setDimmed = vi.fn();
    readonly setPaused = vi.fn();
    readonly applySettings = vi.fn();
    readonly init = vi.fn(() => (mocks.initImpl ? mocks.initImpl() : Promise.resolve(true)));
    constructor(options?: FakeEngine["options"]) {
      this.options = options;
      mocks.instances.push(this);
    }
  }
  return { TerrariumEngine, RenderInitError };
});

const { useTerrarium } = await import("./useTerrarium");
const { RenderInitError } = await import("../rendering/TerrariumEngine");

const latest: { current: TerrariumState | null } = { current: null };

function Probe({
  dimmed,
  renderSettings = DEFAULT_SETTINGS.render,
  renderer = "pixi2d",
}: {
  dimmed: boolean;
  renderSettings?: RenderSettings;
  renderer?: RendererKind;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const state = useTerrarium(hostRef, { dimmed, paused: false, renderSettings, renderer });
  useEffect(() => {
    latest.current = state;
  });
  return <div ref={hostRef} />;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useTerrarium", () => {
  beforeEach(() => {
    mocks.instances.length = 0;
    mocks.initImpl = null;
    mocks.threeInitImpl = null;
    latest.current = null;
  });
  afterEach(() => {
    cleanup();
  });

  it("keeps exactly one live engine under StrictMode and destroys the first", async () => {
    render(
      <StrictMode>
        <Probe dimmed />
      </StrictMode>,
    );
    await flush();

    // The first mount is cancelled while the renderer module is loading, so it never creates an engine.
    const live = mocks.instances.filter((instance) => instance.destroy.mock.calls.length === 0);
    expect(live).toHaveLength(1);
    const second = live[0];
    expect(latest.current?.engine).toBe(second);
    expect(latest.current?.renderError).toBeNull();
    expect(second?.setDimmed).toHaveBeenCalledWith(true);
  });

  it("applies render settings after init and again when they change", async () => {
    const view = render(<Probe dimmed={false} />);
    await flush();
    const engine = mocks.instances[0];
    expect(engine?.applySettings).toHaveBeenCalledWith(DEFAULT_SETTINGS.render);
    const changed: RenderSettings = { ...DEFAULT_SETTINGS.render, maxPlants: 100 };
    view.rerender(<Probe dimmed={false} renderSettings={changed} />);
    await flush();
    expect(engine?.applySettings).toHaveBeenLastCalledWith(changed);
  });

  it("destroys the engine on unmount", async () => {
    const view = render(<Probe dimmed={false} />);
    await flush();
    const engine = mocks.instances[0];
    view.unmount();
    expect(engine?.destroy).toHaveBeenCalledTimes(1);
  });

  it("reports initFailed when init rejects with RenderInitError", async () => {
    mocks.initImpl = () => Promise.reject(new RenderInitError());
    render(<Probe dimmed />);
    await flush();
    expect(latest.current?.engine).toBeNull();
    expect(latest.current?.renderError).toEqual({ source: "render", kind: "initFailed" });
  });

  it("switching the renderer destroys the old engine and leaves exactly one live engine", async () => {
    const view = render(<Probe dimmed={false} renderer="pixi2d" />);
    await flush();
    view.rerender(<Probe dimmed={false} renderer="three3d" />);
    await flush();
    await flush();
    const live = mocks.instances.filter((instance) => instance.destroy.mock.calls.length === 0);
    expect(live).toHaveLength(1);
    expect(live[0]?.kind).toBe("three3d");
    expect(mocks.instances[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(latest.current?.engine).toBe(live[0]);
    expect(latest.current?.activeRenderer).toBe("three3d");
    expect(latest.current?.renderError).toBeNull();
    view.unmount();
    expect(live[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it("falls back to 2D for this run when 3D init fails, with a message and without changing the request", async () => {
    mocks.threeInitImpl = () => Promise.reject(new RenderInitError());
    render(<Probe dimmed={false} renderer="three3d" />);
    await flush();
    await flush();
    await flush();
    const live = mocks.instances.filter((instance) => instance.destroy.mock.calls.length === 0);
    expect(live).toHaveLength(1);
    expect(live[0]?.kind).toBe("pixi2d");
    expect(latest.current?.engine).toBe(live[0]);
    expect(latest.current?.activeRenderer).toBe("pixi2d");
    expect(latest.current?.renderError).toEqual({ source: "render", kind: "fallback2d" });
    const failed = mocks.instances.find((instance) => instance.kind === "three3d");
    expect(failed?.destroy).toHaveBeenCalled();
  });

  it("retries 3D when the request changes away and back after a fallback", async () => {
    mocks.threeInitImpl = () => Promise.reject(new RenderInitError());
    const view = render(<Probe dimmed={false} renderer="three3d" />);
    await flush();
    await flush();
    await flush();
    view.rerender(<Probe dimmed={false} renderer="pixi2d" />);
    await flush();
    expect(latest.current?.renderError).toBeNull();
    mocks.threeInitImpl = null;
    view.rerender(<Probe dimmed={false} renderer="three3d" />);
    await flush();
    await flush();
    expect(latest.current?.activeRenderer).toBe("three3d");
  });

  it("recreates the engine on context loss", async () => {
    render(<Probe dimmed />);
    await flush();
    const first = mocks.instances[0];
    act(() => {
      first?.options?.onContextLost?.();
    });
    await flush();
    expect(first?.destroy).toHaveBeenCalled();
    expect(mocks.instances.length).toBe(2);
    expect(latest.current?.engine).toBe(mocks.instances[1]);
  });

  it("clears the render error banner when a later init succeeds", async () => {
    mocks.initImpl = () => Promise.reject(new RenderInitError());
    render(<Probe dimmed />);
    await flush();
    expect(latest.current?.renderError).toEqual({ source: "render", kind: "initFailed" });
    mocks.initImpl = null;
    act(() => {
      mocks.instances[0]?.options?.onContextLost?.();
    });
    await flush();
    await flush();
    expect(latest.current?.engine).toBe(mocks.instances[1]);
    expect(latest.current?.renderError).toBeNull();
  });
});
