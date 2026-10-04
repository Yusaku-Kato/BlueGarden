// @vitest-environment happy-dom
/// <reference types="node" />
import {
  BufferGeometry,
  InstancedMesh,
  Line,
  Material,
  Mesh,
  Object3D,
  Points,
  SRGBColorSpace,
} from "three";
import type { Scene } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EFFECTS, PARTICLES, PLANT } from "../../config/gardenConfig";
import type { EnvironmentState, Mood, PlantSeed, RenderSettings, WeatherState } from "../../domain/models";
import { setLogSinkForTesting } from "../../infra/logger";
import { RenderInitError, ThreeTerrariumEngine } from "./ThreeTerrariumEngine";

const h = vi.hoisted(() => {
  const events: string[] = [];
  const state = {
    failRendererCreate: false,
    failSetSize: false,
    failRender: false,
    failComposerCreate: false,
  };

  class FakeRenderer {
    options: Record<string, unknown>;
    domElement = document.createElement("canvas");
    outputColorSpace = "";
    pixelRatio = 0;
    sizes: [number, number][] = [];
    loopCallback: ((time: number) => void) | null = null;
    loopStarts = 0;
    renders = 0;
    disposeCalls = 0;
    forceContextLossCalls = 0;
    constructor(options: Record<string, unknown>) {
      if (state.failRendererCreate) throw new Error("no webgl");
      this.options = options;
      registry.renderers.push(this);
      const canvas = this.domElement;
      const remove = canvas.removeEventListener.bind(canvas);
      canvas.removeEventListener = ((name: string, listener: EventListenerOrEventListenerObject) => {
        events.push(`canvas.removeEventListener:${name}`);
        remove(name, listener);
      }) as typeof canvas.removeEventListener;
    }
    setPixelRatio(ratio: number): void {
      this.pixelRatio = ratio;
    }
    setSize(width: number, height: number): void {
      if (state.failSetSize) throw new Error("setSize failed");
      this.sizes.push([width, height]);
    }
    setClearColor(): void {}
    setAnimationLoop(callback: ((time: number) => void) | null): void {
      this.loopCallback = callback;
      if (callback !== null) this.loopStarts += 1;
      events.push(callback === null ? "loop.stop" : "loop.start");
    }
    render(): void {
      if (state.failRender) throw new Error("render failed");
      this.renders += 1;
    }
    dispose(): void {
      this.disposeCalls += 1;
      events.push("renderer.dispose");
    }
    forceContextLoss(): void {
      this.forceContextLossCalls += 1;
      events.push("renderer.forceContextLoss");
    }
  }

  class FakePass {
    enabled = true;
    disposeCalls = 0;
    dispose(): void {
      this.disposeCalls += 1;
    }
  }
  class FakeRenderPass extends FakePass {}
  class FakeBloomPass extends FakePass {
    strength = 0;
  }
  class FakeBokehPass extends FakePass {}
  class FakeOutputPass extends FakePass {}

  class FakeComposer {
    passes: FakePass[] = [];
    renders = 0;
    sizes: [number, number][] = [];
    disposeCalls = 0;
    constructor() {
      if (state.failComposerCreate) throw new Error("composer failed");
      registry.composers.push(this);
    }
    addPass(pass: FakePass): void {
      this.passes.push(pass);
      registry.passes.push(pass);
    }
    setSize(width: number, height: number): void {
      this.sizes.push([width, height]);
    }
    render(): void {
      this.renders += 1;
    }
    dispose(): void {
      this.disposeCalls += 1;
    }
  }

  class FakeResizeObserver {
    observed: Element[] = [];
    disconnected = 0;
    constructor(readonly callback: () => void) {
      registry.observers.push(this);
    }
    observe(element: Element): void {
      this.observed.push(element);
    }
    disconnect(): void {
      this.disconnected += 1;
      events.push("resizeObserver.disconnect");
    }
    unobserve(): void {}
  }

  const registry = {
    renderers: [] as FakeRenderer[],
    composers: [] as FakeComposer[],
    passes: [] as FakePass[],
    observers: [] as FakeResizeObserver[],
  };

  return {
    events,
    state,
    registry,
    FakeRenderer,
    FakeComposer,
    FakeRenderPass,
    FakeBloomPass,
    FakeBokehPass,
    FakeOutputPass,
    FakeResizeObserver,
  };
});

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return { ...actual, WebGLRenderer: h.FakeRenderer };
});
vi.mock("three/addons/postprocessing/EffectComposer.js", () => ({ EffectComposer: h.FakeComposer }));
vi.mock("three/addons/postprocessing/RenderPass.js", () => ({ RenderPass: h.FakeRenderPass }));
vi.mock("three/addons/postprocessing/UnrealBloomPass.js", () => ({ UnrealBloomPass: h.FakeBloomPass }));
vi.mock("three/addons/postprocessing/BokehPass.js", () => ({ BokehPass: h.FakeBokehPass }));
vi.mock("three/addons/postprocessing/OutputPass.js", () => ({ OutputPass: h.FakeOutputPass }));

interface HostSize {
  width: number;
  height: number;
}

function makeHost(size: HostSize = { width: 800, height: 600 }): { host: HTMLElement; size: HostSize } {
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { get: () => size.width });
  Object.defineProperty(host, "clientHeight", { get: () => size.height });
  document.body.appendChild(host);
  return { host, size };
}

function makeSeed(index: number, mood: Mood = "neutral"): PlantSeed {
  return {
    id: `plant-${String(index)}`,
    mood,
    color: 0x100000 + index,
    scale: 1,
    growthDurationMs: 1_000,
    thorny: mood === "negative",
  };
}

function envWith(
  weather: Partial<WeatherState> = {},
  extras: Partial<Omit<EnvironmentState, "weather">> = {},
): EnvironmentState {
  return {
    weather: { postsPerMinute: 0, rain: 0, wind: 0, light: 0, fog: 0, fireflies: 0, ...weather },
    dayPhase: 0.5,
    climate: "temperate",
    ...extras,
  };
}

const DEFAULT_TEST_SETTINGS: RenderSettings = {
  maxPlants: 300,
  plantLifetimeMs: 180_000,
  animationSpeed: 1,
  particleIntensity: 1,
  windIntensity: 1,
  theme: "twilight",
  effects: {
    lightParticles: true,
    rain: true,
    wind: true,
    fog: true,
    fireflies: true,
    bloom: true,
    dayNightCycle: true,
    climate: true,
  },
};

function settingsWith(
  overrides: Partial<Omit<RenderSettings, "effects">> = {},
  effects: Partial<RenderSettings["effects"]> = {},
): RenderSettings {
  return {
    ...DEFAULT_TEST_SETTINGS,
    ...overrides,
    effects: { ...DEFAULT_TEST_SETTINGS.effects, ...effects },
  };
}

function seededRandom(seed = 7): () => number {
  let value = seed;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return value / 4_294_967_296;
  };
}

interface Internals {
  scene: Scene | null;
  plantIndex: Map<string, unknown>;
  plants: unknown[];
}

function internals(engine: ThreeTerrariumEngine): Internals {
  return engine as unknown as Internals;
}

function lastRenderer(): InstanceType<typeof h.FakeRenderer> {
  const renderer = h.registry.renderers[h.registry.renderers.length - 1];
  if (renderer === undefined) throw new Error("no fake renderer was created");
  return renderer;
}

let clock = 0;

/** One render-loop callback `deltaMs` after the previous one. */
function frame(deltaMs: number): void {
  const callback = lastRenderer().loopCallback;
  if (callback === null) throw new Error("render loop is not running");
  clock += deltaMs;
  callback(clock);
}

function frames(count: number, deltaMs = 250): void {
  for (let index = 0; index < count; index += 1) frame(deltaMs);
}

function sceneOf(engine: ThreeTerrariumEngine): Scene {
  const scene = internals(engine).scene;
  if (scene === null) throw new Error("engine has no scene");
  return scene;
}

type PlantMesh = InstancedMesh<BufferGeometry, Material>;

function asInstanced(object: Object3D): PlantMesh | null {
  return object instanceof InstancedMesh ? (object as PlantMesh) : null;
}

function instancedCount(engine: ThreeTerrariumEngine): number {
  let total = 0;
  for (const child of sceneOf(engine).children) total += asInstanced(child)?.count ?? 0;
  return total;
}

/** Scale values written for the first `count` slots of every plant batch. */
function plantScales(engine: ThreeTerrariumEngine): number[] {
  const scales: number[] = [];
  for (const child of sceneOf(engine).children) {
    const mesh = asInstanced(child);
    if (mesh === null) continue;
    const params = mesh.geometry.getAttribute("aParams");
    for (let slot = 0; slot < mesh.count; slot += 1) scales.push(params.getX(slot));
  }
  return scales;
}

async function startEngine(
  options: ConstructorParameters<typeof ThreeTerrariumEngine>[0] = {},
  host: HTMLElement = makeHost().host,
): Promise<ThreeTerrariumEngine> {
  const engine = new ThreeTerrariumEngine({ resolution: 1, random: seededRandom(), ...options });
  const ok = await engine.init(host);
  expect(ok).toBe(true);
  return engine;
}

let restoreLog: () => void;
let unhandled: unknown[];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  clock = 1_000;
  h.events.length = 0;
  h.registry.renderers.length = 0;
  h.registry.composers.length = 0;
  h.registry.passes.length = 0;
  h.registry.observers.length = 0;
  h.state.failRendererCreate = false;
  h.state.failSetSize = false;
  h.state.failRender = false;
  h.state.failComposerCreate = false;
  vi.stubGlobal("ResizeObserver", h.FakeResizeObserver);
  document.body.innerHTML = "";
  restoreLog = setLogSinkForTesting(() => undefined);
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  restoreLog();
  vi.unstubAllGlobals();
});

describe("init and state machine", () => {
  it("creates an antialiased sRGB renderer, appends the canvas and starts one render loop", async () => {
    const { host } = makeHost();
    const engine = new ThreeTerrariumEngine({ resolution: 1.5 });
    expect(await engine.init(host)).toBe(true);
    const renderer = lastRenderer();
    expect(renderer.options["antialias"]).toBe(true);
    expect(renderer.options["powerPreference"]).toBe("default");
    expect(renderer.outputColorSpace).toBe(SRGBColorSpace);
    expect(renderer.pixelRatio).toBe(1.5);
    expect(renderer.sizes[0]).toEqual([800, 600]);
    expect(host.contains(renderer.domElement)).toBe(true);
    expect(renderer.loopStarts).toBe(1);
    expect(h.registry.observers).toHaveLength(1);
    engine.destroy();
  });

  it("returns false for a second init and after destroy", async () => {
    const engine = await startEngine();
    expect(await engine.init(makeHost().host)).toBe(false);
    engine.destroy();
    expect(await engine.init(makeHost().host)).toBe(false);
    expect(h.registry.renderers).toHaveLength(1);
  });

  it("destroy right after init() cancels before a WebGL context is created (StrictMode)", async () => {
    const engine = new ThreeTerrariumEngine();
    const pending = engine.init(makeHost().host);
    engine.destroy();
    expect(await pending).toBe(false);
    expect(h.registry.renderers).toHaveLength(0);
    expect(() => {
      engine.addPlant(makeSeed(1));
      engine.setPaused(true);
    }).not.toThrow();
    expect(engine.getStats()).toEqual({ plants: 0, queued: 0, particles: 0, effectObjects: 0 });
  });

  it("destroy before init makes a later init return false", async () => {
    const engine = new ThreeTerrariumEngine();
    engine.destroy();
    expect(await engine.init(makeHost().host)).toBe(false);
    expect(h.registry.renderers).toHaveLength(0);
  });

  it("rejects with RenderInitError when WebGL is unavailable and stays unusable", async () => {
    h.state.failRendererCreate = true;
    const engine = new ThreeTerrariumEngine();
    await expect(engine.init(makeHost().host)).rejects.toBeInstanceOf(RenderInitError);
    expect(await engine.init(makeHost().host)).toBe(false);
    expect(() => {
      engine.addPlant(makeSeed(1));
      engine.destroy();
    }).not.toThrow();
  });

  it("cleans up a half-built scene when setup fails after the renderer exists", async () => {
    h.state.failSetSize = true;
    const { host } = makeHost();
    const engine = new ThreeTerrariumEngine();
    await expect(engine.init(host)).rejects.toBeInstanceOf(RenderInitError);
    const renderer = lastRenderer();
    expect(renderer.disposeCalls).toBe(1);
    expect(renderer.forceContextLossCalls).toBe(1);
    expect(host.contains(renderer.domElement)).toBe(false);
  });

  it("keeps values set before running and applies them", async () => {
    const engine = new ThreeTerrariumEngine({ resolution: 1, random: () => 0.5 });
    engine.setPaused(true);
    engine.applySettings(settingsWith({ maxPlants: 50 }));
    engine.setEnvironment(envWith({ rain: 1 }));
    engine.setDimmed(true);
    for (let index = 0; index < 10; index += 1) engine.addPlant(makeSeed(index));
    expect(engine.getStats().queued).toBe(10);
    expect(await engine.init(makeHost().host)).toBe(true);
    const renderer = lastRenderer();
    expect(renderer.loopCallback).toBeNull(); // paused before init: the loop never started
    expect(renderer.loopStarts).toBe(0);
    expect(renderer.domElement.style.opacity).toBe("0.6");
    engine.setPaused(false);
    expect(renderer.loopStarts).toBe(1);
    frames(40);
    expect(engine.getStats().plants).toBeGreaterThan(0);
    expect(engine.getStats().effectObjects).toBeGreaterThan(0); // the early rain value was applied
    engine.destroy();
  });
});

describe("render loop", () => {
  it("stops and restarts the loop with setPaused", async () => {
    const engine = await startEngine();
    const renderer = lastRenderer();
    expect(renderer.loopCallback).not.toBeNull();
    engine.setPaused(true);
    expect(renderer.loopCallback).toBeNull();
    engine.setPaused(true);
    engine.setPaused(false);
    expect(renderer.loopCallback).not.toBeNull();
    engine.destroy();
    expect(renderer.loopCallback).toBeNull();
  });

  it("does not age plants across a pause", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.applySettings(settingsWith({ plantLifetimeMs: 60_000 }));
    engine.addPlant(makeSeed(1));
    frames(2);
    expect(engine.getStats().plants).toBe(1);
    engine.setPaused(true);
    engine.setPaused(false);
    clock += 10 * 60_000; // the window was hidden for 10 minutes
    frame(16);
    expect(engine.getStats().plants).toBe(1);
    engine.destroy();
  });

  it("caps the frame rate at 60 FPS", async () => {
    const engine = await startEngine();
    engine.applySettings(settingsWith({}, { bloom: false }));
    const renderer = lastRenderer();
    frame(100);
    frame(5);
    frame(5);
    expect(renderer.renders).toBe(1);
    frame(8); // 18 ms after the last rendered frame
    expect(renderer.renders).toBe(2);
    engine.destroy();
  });

  it("ignores non-finite times and never throws from the loop", async () => {
    const engine = await startEngine();
    const callback = lastRenderer().loopCallback;
    expect(callback).not.toBeNull();
    expect(() => {
      callback?.(Number.NaN);
      callback?.(Number.POSITIVE_INFINITY);
    }).not.toThrow();
    h.state.failRender = true;
    expect(() => {
      frames(3);
    }).not.toThrow();
    h.state.failRender = false;
    engine.destroy();
  });

  it("uses plain rendering without bloom and the composer with bloom", async () => {
    const engine = await startEngine();
    engine.applySettings(settingsWith({}, { bloom: false }));
    frames(3);
    expect(h.registry.composers).toHaveLength(0);
    expect(lastRenderer().renders).toBe(3);
    engine.applySettings(settingsWith({}, { bloom: true }));
    frames(3);
    const composer = h.registry.composers[0];
    expect(composer?.renders).toBe(3);
    expect(composer?.passes).toHaveLength(4);
    expect(lastRenderer().renders).toBe(3);
    engine.destroy();
  });

  it("falls back to plain rendering when the composer cannot be created", async () => {
    h.state.failComposerCreate = true;
    const engine = await startEngine();
    expect(() => {
      frames(4);
    }).not.toThrow();
    expect(lastRenderer().renders).toBe(4);
    expect(h.registry.composers).toHaveLength(0);
    engine.destroy();
  });

  it("drops the depth of field for good when frames stay slow", async () => {
    const engine = await startEngine();
    frame(16);
    const bokeh = h.registry.passes.find((pass) => pass instanceof h.FakeBokehPass);
    expect(bokeh?.enabled).toBe(true);
    frames(150, 45);
    expect(bokeh?.enabled).toBe(false);
    frames(10, 16);
    expect(bokeh?.enabled).toBe(false);
    engine.destroy();
  });

  it("dims the canvas smoothly and restores it", async () => {
    const engine = await startEngine();
    const canvas = lastRenderer().domElement;
    frame(16);
    expect(canvas.style.opacity).toBe("1");
    engine.setDimmed(true);
    frames(30, 100);
    expect(canvas.style.opacity).toBe("0.6");
    engine.setDimmed(false);
    frames(30, 100);
    expect(canvas.style.opacity).toBe("1");
    engine.destroy();
  });
});

describe("spawn queue", () => {
  it("drops the oldest seed when the queue overflows", async () => {
    const engine = await startEngine();
    for (let index = 0; index < PLANT.SPAWN_QUEUE_LIMIT + 20; index += 1) engine.addPlant(makeSeed(index));
    expect(engine.getStats().queued).toBe(PLANT.SPAWN_QUEUE_LIMIT);
    expect(internals(engine).plantIndex.size).toBe(PLANT.SPAWN_QUEUE_LIMIT);
    engine.destroy();
  });

  it("spawns at most one plant per frame regardless of delta", async () => {
    const engine = await startEngine();
    for (let index = 0; index < 20; index += 1) engine.addPlant(makeSeed(index));
    frame(16);
    frame(250);
    expect(engine.getStats().plants).toBeLessThanOrEqual(1);
    frame(10_000);
    expect(engine.getStats().plants).toBeLessThanOrEqual(2);
    engine.destroy();
  });

  it("clearPending empties the queue and the id map", async () => {
    const engine = await startEngine();
    for (let index = 0; index < 10; index += 1) engine.addPlant(makeSeed(index));
    engine.clearPending();
    expect(engine.getStats().queued).toBe(0);
    expect(internals(engine).plantIndex.size).toBe(0);
    engine.destroy();
  });

  it("fadeOutAll clears the queue and fades every living plant out, then destroys them", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.applySettings(settingsWith({ plantLifetimeMs: 600_000 }));
    for (let index = 0; index < 4; index += 1) {
      engine.addPlant(makeSeed(index));
      frame(250);
    }
    frame(250);
    for (let index = 10; index < 15; index += 1) engine.addPlant(makeSeed(index));
    expect(engine.getStats().plants).toBe(4);
    engine.fadeOutAll(1_000);
    expect(engine.getStats().queued).toBe(0);
    expect(internals(engine).plantIndex.size).toBe(4);
    frame(250);
    expect(engine.getStats().plants).toBe(4);
    frame(250);
    frame(250);
    frame(250);
    frame(250);
    expect(engine.getStats().plants).toBe(0);
    expect(instancedCount(engine)).toBe(0);
    expect(internals(engine).plantIndex.size).toBe(0);

    engine.addPlant(makeSeed(100));
    frame(250);
    expect(engine.getStats().plants).toBe(1);
    frames(8);
    expect(engine.getStats().plants).toBe(1);
    engine.destroy();
    expect(() => {
      engine.fadeOutAll(1_000);
    }).not.toThrow();
    expect(internals(engine).plantIndex.size).toBe(0);
  });
});

describe("plant cap, eviction and lifetime", () => {
  it("never exceeds the plant cap and evicts the oldest, keeping slots and plants in step", async () => {
    const engine = await startEngine({ random: seededRandom(3) });
    engine.applySettings(settingsWith({ maxPlants: 50 }));
    let evictedAtLeastOnce = false;
    let peak = 0;
    for (let index = 0; index < 400; index += 1) {
      engine.addPlant(makeSeed(index, index % 3 === 0 ? "positive" : index % 3 === 1 ? "neutral" : "negative"));
      frame(250);
      const plants = engine.getStats().plants;
      peak = Math.max(peak, plants);
      expect(plants).toBeLessThanOrEqual(50);
      expect(instancedCount(engine)).toBe(plants);
      if (index > 100 && plants < 50) evictedAtLeastOnce = true;
    }
    expect(peak).toBe(50);
    expect(evictedAtLeastOnce).toBe(true);
    expect(internals(engine).plantIndex.size).toBeLessThanOrEqual(50 + PLANT.SPAWN_QUEUE_LIMIT);
    engine.destroy();
  });

  it("holds the default cap of 300 plants", async () => {
    const engine = await startEngine({ random: seededRandom(5) });
    for (let index = 0; index < 700; index += 1) {
      engine.addPlant(makeSeed(index));
      frame(250);
      expect(engine.getStats().plants).toBeLessThanOrEqual(PLANT.MAX_PLANTS);
    }
    expect(engine.getStats().plants).toBeGreaterThan(200);
    engine.destroy();
  });

  it("frees the instance slot and id when the lifetime ends", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.applySettings(settingsWith({ plantLifetimeMs: 60_000 }));
    for (let index = 0; index < 5; index += 1) {
      engine.addPlant(makeSeed(index));
      frame(250);
    }
    frame(250); // the very first frame has no delta
    expect(engine.getStats().plants).toBe(5);
    expect(instancedCount(engine)).toBe(5);
    frames(300);
    expect(engine.getStats().plants).toBe(0);
    expect(instancedCount(engine)).toBe(0);
    expect(internals(engine).plantIndex.size).toBe(0);
    engine.destroy();
  });

  it("clamps invalid seed values instead of throwing", async () => {
    const engine = await startEngine();
    const bad: PlantSeed = {
      id: "bad",
      mood: "positive",
      color: Number.NaN,
      scale: Number.NaN,
      growthDurationMs: Number.NaN,
      thorny: false,
    };
    engine.addPlant(bad);
    engine.addPlant({ ...makeSeed(2), scale: 999, growthDurationMs: -5 });
    expect(() => {
      frames(10);
    }).not.toThrow();
    for (const scale of plantScales(engine)) expect(Number.isFinite(scale)).toBe(true);
    engine.destroy();
  });

  it("lowers maxPlants gradually, never evicting everything in one frame", async () => {
    const engine = await startEngine({ random: seededRandom(11) });
    for (let index = 0; index < 120; index += 1) {
      engine.addPlant(makeSeed(index));
      frame(250);
    }
    const before = engine.getStats().plants;
    expect(before).toBeGreaterThan(80);
    engine.applySettings(settingsWith({ maxPlants: 50 }));
    frame(250);
    expect(engine.getStats().plants).toBeGreaterThan(before - PLANT.SPAWN_PER_SECOND * 2);
    frames(80);
    expect(engine.getStats().plants).toBeLessThanOrEqual(50);
    engine.destroy();
  });
});

describe("growPlant", () => {
  it("ignores unknown ids and invalid scales without throwing", async () => {
    const engine = await startEngine();
    engine.addPlant(makeSeed(1));
    frame(250);
    expect(() => {
      engine.growPlant("missing", 2);
      engine.growPlant("plant-1", Number.NaN);
      engine.growPlant("plant-1", Number.POSITIVE_INFINITY);
      engine.growPlant("plant-1", "2" as unknown as number);
    }).not.toThrow();
    engine.destroy();
  });

  it("raises a living plant smoothly and never shrinks it", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.addPlant({ ...makeSeed(1), scale: 1 });
    frames(20);
    const base = plantScales(engine)[0] ?? 0;
    expect(base).toBeGreaterThan(0);
    engine.growPlant("plant-1", 2);
    frame(100);
    const mid = plantScales(engine)[0] ?? 0;
    expect(mid).toBeGreaterThan(base);
    frames(40);
    const grown = plantScales(engine)[0] ?? 0;
    expect(grown).toBeGreaterThan(mid);
    expect(grown / base).toBeCloseTo(2, 1);
    engine.growPlant("plant-1", 0.8);
    frames(40);
    expect(plantScales(engine)[0] ?? 0).toBeCloseTo(grown, 3);
    engine.destroy();
  });

  it("raises a queued seed before it spawns", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.addPlant({ ...makeSeed(1), scale: 1 });
    engine.growPlant("plant-1", 2);
    expect(engine.getStats().queued).toBe(1);
    frames(20);
    expect(engine.getStats().plants).toBe(1);
    expect((plantScales(engine)[0] ?? 0) / 1.5).toBeCloseTo(2, 1);
    engine.destroy();
  });

  it("keeps the id map bounded and cleans it on removal, clearPending and destroy", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    for (let index = 0; index < PLANT.SPAWN_QUEUE_LIMIT + 50; index += 1) engine.addPlant(makeSeed(index));
    expect(internals(engine).plantIndex.size).toBeLessThanOrEqual(PLANT.SPAWN_QUEUE_LIMIT);
    engine.clearPending();
    expect(internals(engine).plantIndex.size).toBe(0);

    engine.applySettings(settingsWith({ plantLifetimeMs: 60_000 }));
    for (let index = 0; index < 5; index += 1) {
      engine.addPlant(makeSeed(500 + index));
      frame(250);
    }
    expect(internals(engine).plantIndex.size).toBe(5);
    frames(300);
    expect(engine.getStats().plants).toBe(0);
    expect(internals(engine).plantIndex.size).toBe(0);
    engine.growPlant("plant-500", 2); // removed plant: no-op

    for (let index = 0; index < 400; index += 1) {
      engine.addPlant(makeSeed(2_000 + index));
      frame(250);
      expect(internals(engine).plantIndex.size).toBeLessThanOrEqual(PLANT.MAX_PLANTS + PLANT.SPAWN_QUEUE_LIMIT);
    }
    engine.destroy();
    expect(internals(engine).plantIndex.size).toBe(0);
    expect(() => {
      engine.growPlant("plant-2000", 2);
    }).not.toThrow();
  });
});

describe("environment effects", () => {
  it("builds rain gradually and never above RAIN_MAX_DROPS", async () => {
    const engine = await startEngine();
    engine.applySettings(settingsWith({ particleIntensity: 2 }));
    engine.setEnvironment(envWith({ rain: 1 }));
    frame(250);
    frame(250);
    const early = engine.getStats().effectObjects;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(EFFECTS.RAIN_MAX_DROPS);
    for (let index = 0; index < 400; index += 1) {
      frame(250);
      expect(engine.getStats().effectObjects).toBeLessThanOrEqual(EFFECTS.RAIN_MAX_DROPS + EFFECTS.FIREFLIES_MAX);
    }
    expect(engine.getStats().effectObjects).toBe(EFFECTS.RAIN_MAX_DROPS);
    engine.destroy();
  });

  it("caps fireflies and light particles", async () => {
    const engine = await startEngine({ random: seededRandom(9) });
    engine.applySettings(settingsWith({ particleIntensity: 2 }));
    engine.setEnvironment(envWith({ postsPerMinute: 500, fireflies: 1 }));
    let maxParticles = 0;
    for (let index = 0; index < 1_200; index += 1) {
      frame(100);
      const stats = engine.getStats();
      maxParticles = Math.max(maxParticles, stats.particles);
      expect(stats.particles).toBeLessThanOrEqual(PARTICLES.MAX_PARTICLES);
      expect(stats.effectObjects).toBeLessThanOrEqual(EFFECTS.FIREFLIES_MAX);
    }
    expect(maxParticles).toBeGreaterThan(10);
    expect(engine.getStats().effectObjects).toBe(EFFECTS.FIREFLIES_MAX);
    engine.destroy();
  });

  it("spawns no light particles below the activity threshold", async () => {
    const engine = await startEngine();
    engine.setEnvironment(envWith({ postsPerMinute: PARTICLES.THRESHOLD_PPM - 5 }));
    frames(80, 100);
    expect(engine.getStats().particles).toBe(0);
    engine.destroy();
  });

  it("releases rain, fireflies and light particles when their toggles are off", async () => {
    const engine = await startEngine({ random: seededRandom(2) });
    engine.setEnvironment(envWith({ postsPerMinute: 200, rain: 1, fireflies: 1 }));
    frames(300, 100);
    const busy = engine.getStats();
    expect(busy.particles).toBeGreaterThan(0);
    expect(busy.effectObjects).toBeGreaterThan(EFFECTS.FIREFLIES_MAX);

    engine.applySettings(settingsWith({}, { rain: false, fireflies: false, lightParticles: false }));
    frames(120, 100);
    expect(engine.getStats().particles).toBe(0);
    expect(engine.getStats().effectObjects).toBe(0);
    engine.destroy();
  });

  it("releases rain once rain stops", async () => {
    const engine = await startEngine({ random: seededRandom(4) });
    engine.setEnvironment(envWith({ rain: 1 }));
    frames(300, 100);
    expect(engine.getStats().effectObjects).toBeGreaterThan(100);
    engine.setEnvironment(envWith({ rain: 0 }));
    frames(600, 100);
    expect(engine.getStats().effectObjects).toBe(0);
    engine.destroy();
  });

  it("scales rain density with particleIntensity and zero intensity means no rain", async () => {
    const engine = await startEngine();
    engine.applySettings(settingsWith({ particleIntensity: 0 }));
    engine.setEnvironment(envWith({ rain: 1 }));
    frames(100, 100);
    expect(engine.getStats().effectObjects).toBe(0);
    engine.destroy();
  });

  it("does not let a failing render step stop the loop", async () => {
    const engine = await startEngine();
    engine.setEnvironment(envWith({ rain: 1 }));
    h.state.failRender = true;
    expect(() => {
      frames(5);
    }).not.toThrow();
    h.state.failRender = false;
    frames(3);
    expect(engine.getStats().effectObjects).toBeGreaterThan(0);
    engine.destroy();
  });

  it("ignores invalid environment values", async () => {
    const engine = await startEngine();
    engine.setEnvironment(envWith({ rain: Number.NaN, wind: 5, fog: -2 }, { dayPhase: Number.NaN }));
    expect(() => {
      frames(10, 100);
    }).not.toThrow();
    engine.destroy();
  });
});

describe("resize and context loss", () => {
  it("applies a new host size, and ignores a zero size", async () => {
    const { host, size } = makeHost();
    const engine = await startEngine({}, host);
    const renderer = lastRenderer();
    const observer = h.registry.observers[0];
    expect(observer?.observed).toEqual([host]);
    size.width = 1000;
    size.height = 500;
    observer?.callback();
    expect(renderer.sizes[renderer.sizes.length - 1]).toEqual([1000, 500]);
    const calls = renderer.sizes.length;
    size.width = 0;
    observer?.callback();
    expect(renderer.sizes).toHaveLength(calls);
    engine.destroy();
  });

  it("falls back to window resize when ResizeObserver does not exist", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const engine = await startEngine();
    expect(addSpy.mock.calls.some(([name]) => name === "resize")).toBe(true);
    engine.destroy();
    expect(removeSpy.mock.calls.some(([name]) => name === "resize")).toBe(true);
  });

  it("prevents the default and reports a lost WebGL context once", async () => {
    const onContextLost = vi.fn();
    const engine = await startEngine({ onContextLost });
    const canvas = lastRenderer().domElement;
    const first = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onContextLost).toHaveBeenCalledTimes(1);
    engine.destroy();
  });

  it("survives a throwing context-lost callback", async () => {
    const engine = await startEngine({
      onContextLost: () => {
        throw new Error("boom");
      },
    });
    expect(() => {
      lastRenderer().domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    }).not.toThrow();
    engine.destroy();
  });
});

describe("destroy", () => {
  it("stops the loop, removes the listener before forceContextLoss, and removes the canvas", async () => {
    const { host } = makeHost();
    const onContextLost = vi.fn();
    const engine = await startEngine({ onContextLost }, host);
    const renderer = lastRenderer();
    engine.addPlant(makeSeed(1));
    frames(5);
    h.events.length = 0;

    engine.destroy();
    const lossListener = h.events.indexOf("canvas.removeEventListener:webglcontextlost");
    const forceLoss = h.events.indexOf("renderer.forceContextLoss");
    const dispose = h.events.indexOf("renderer.dispose");
    expect(h.events.indexOf("loop.stop")).toBeGreaterThanOrEqual(0);
    expect(lossListener).toBeGreaterThanOrEqual(0);
    expect(lossListener).toBeLessThan(forceLoss);
    expect(dispose).toBeGreaterThanOrEqual(0);
    expect(dispose).toBeLessThan(forceLoss);
    expect(h.events.filter((event) => event === "renderer.dispose")).toHaveLength(1);
    expect(h.events.filter((event) => event === "renderer.forceContextLoss")).toHaveLength(1);
    expect(h.events).toContain("resizeObserver.disconnect");
    expect(renderer.loopCallback).toBeNull();
    expect(host.contains(renderer.domElement)).toBe(false);

    // A loss event after teardown must not reach the owner.
    renderer.domElement.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onContextLost).not.toHaveBeenCalled();
  });

  it("empties every collection, makes later calls no-ops and is idempotent", async () => {
    const engine = await startEngine({ random: seededRandom(6) });
    engine.setEnvironment(envWith({ rain: 1, fireflies: 1, postsPerMinute: 200 }));
    for (let index = 0; index < 30; index += 1) {
      engine.addPlant(makeSeed(index));
      frame(250);
    }
    for (let index = 100; index < 110; index += 1) engine.addPlant(makeSeed(index));
    expect(engine.getStats().plants).toBeGreaterThan(0);

    engine.destroy();
    engine.destroy();
    expect(engine.getStats()).toEqual({ plants: 0, queued: 0, particles: 0, effectObjects: 0 });
    expect(internals(engine).plantIndex.size).toBe(0);
    expect(internals(engine).plants).toHaveLength(0);
    expect(internals(engine).scene).toBeNull();
    expect(() => {
      engine.addPlant(makeSeed(999));
      engine.growPlant("plant-1", 2);
      engine.setEnvironment(envWith({ rain: 1 }));
      engine.applySettings(settingsWith());
      engine.setDimmed(true);
      engine.setPaused(true);
      engine.clearPending();
    }).not.toThrow();
    expect(engine.getStats().queued).toBe(0);
    expect(h.events.filter((event) => event === "renderer.dispose")).toHaveLength(1);
    expect(h.events.filter((event) => event === "renderer.forceContextLoss")).toHaveLength(1);
  });

  it("disposes every geometry, material, mesh, pass and composer exactly once", async () => {
    const geometryDispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    const materialDispose = vi.spyOn(Material.prototype, "dispose");
    const meshDispose = vi.spyOn(InstancedMesh.prototype, "dispose");
    const engine = await startEngine({ random: seededRandom(8) });
    engine.setEnvironment(envWith({ rain: 1, fireflies: 1, postsPerMinute: 200 }));
    for (let index = 0; index < 20; index += 1) {
      engine.addPlant(makeSeed(index, index % 2 === 0 ? "positive" : "negative"));
      frame(250);
    }
    frames(20, 100);

    const scene = sceneOf(engine);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    const instancedMeshes: PlantMesh[] = [];
    scene.traverse((object: Object3D) => {
      if (object instanceof Mesh || object instanceof Points || object instanceof Line) {
        const geometry = object.geometry as BufferGeometry;
        geometries.add(geometry);
        const material = object.material as Material | Material[];
        for (const entry of Array.isArray(material) ? material : [material]) materials.add(entry);
      }
      const instanced = asInstanced(object);
      if (instanced !== null) instancedMeshes.push(instanced);
    });
    expect(geometries.size).toBeGreaterThan(10);
    expect(materials.size).toBeGreaterThan(3);
    expect(instancedMeshes.length).toBeGreaterThan(5);
    geometryDispose.mockClear();
    materialDispose.mockClear();
    meshDispose.mockClear();

    engine.destroy();
    for (const geometry of geometries) {
      expect(geometryDispose.mock.instances.filter((instance) => instance === geometry)).toHaveLength(1);
    }
    for (const material of materials) {
      expect(materialDispose.mock.instances.filter((instance) => instance === material)).toHaveLength(1);
    }
    for (const mesh of instancedMeshes) {
      expect(meshDispose.mock.instances.filter((instance) => instance === mesh)).toHaveLength(1);
    }
    expect(scene.children).toHaveLength(0);
    for (const pass of h.registry.passes) expect(pass.disposeCalls).toBe(1);
    expect(h.registry.passes.length).toBe(4);
    for (const composer of h.registry.composers) expect(composer.disposeCalls).toBe(1);
    expect(lastRenderer().disposeCalls).toBe(1);
    expect(lastRenderer().forceContextLossCalls).toBe(1);
  });

  it("is safe to create and destroy repeatedly (StrictMode style) without leaving canvases", async () => {
    const { host } = makeHost();
    for (let round = 0; round < 5; round += 1) {
      const engine = new ThreeTerrariumEngine({ resolution: 1 });
      const pending = engine.init(host);
      if (round % 2 === 0) engine.destroy();
      const ok = await pending;
      expect(ok).toBe(round % 2 !== 0);
      engine.destroy();
    }
    expect(host.querySelectorAll("canvas")).toHaveLength(0);
    expect(h.registry.renderers).toHaveLength(2);
    for (const renderer of h.registry.renderers) {
      expect(renderer.disposeCalls).toBe(1);
      expect(renderer.forceContextLossCalls).toBe(1);
    }
    expect(unhandled).toEqual([]);
  });

  it("still reaches renderer.dispose and forceContextLoss when other teardown steps throw", async () => {
    const engine = await startEngine();
    frames(3);
    const bloom = h.registry.passes.find((pass) => pass instanceof h.FakeBloomPass);
    if (bloom !== undefined) {
      bloom.dispose = () => {
        throw new Error("pass dispose failed");
      };
    }
    engine.destroy();
    expect(lastRenderer().disposeCalls).toBe(1);
    expect(lastRenderer().forceContextLossCalls).toBe(1);
  });
});
