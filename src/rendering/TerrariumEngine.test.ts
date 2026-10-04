/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EFFECTS, PARTICLES, PLANT } from "../config/gardenConfig";
import type { EnvironmentState, Mood, PlantSeed, RenderSettings, WeatherState } from "../domain/models";
import { setLogSinkForTesting } from "../infra/logger";
import { RenderInitError, TerrariumEngine } from "./TerrariumEngine";

const h = vi.hoisted(() => {
  const events: string[] = [];
  const state = {
    initImpl: (): Promise<void> => Promise.resolve(),
    failGraphicsCreate: false,
    failViewDestroy: false,
    failTickerRemove: false,
    failRendererOff: false,
    failContextDestroy: false,
    screenWidth: 800,
    screenHeight: 600,
  };

  class FakePoint {
    x = 0;
    y = 0;
    set(x: number, y: number = x): void {
      this.x = x;
      this.y = y;
    }
  }

  class FakeGraphicsContext {
    destroyCalls = 0;
    constructor() {
      registry.contexts.push(this);
    }
    moveTo(): this {
      return this;
    }
    quadraticCurveTo(): this {
      return this;
    }
    ellipse(): this {
      return this;
    }
    lineTo(): this {
      return this;
    }
    circle(): this {
      return this;
    }
    poly(): this {
      return this;
    }
    fill(): this {
      return this;
    }
    stroke(): this {
      return this;
    }
    destroy(): void {
      this.destroyCalls += 1;
      events.push("context.destroy");
      if (state.failContextDestroy) throw new Error("context destroy failed");
    }
  }

  class FakeContainer {
    children: FakeContainer[] = [];
    parent: FakeContainer | null = null;
    position = new FakePoint();
    scale = new FakePoint();
    rotation = 0;
    alpha = 1;
    zIndex = 0;
    tint = 0xffffff;
    blendMode = "normal";
    eventMode = "";
    interactiveChildren = true;
    sortableChildren = false;
    destroyed = false;
    destroyCalls: unknown[] = [];
    constructor() {
      registry.containers.push(this);
    }
    addChild(child: FakeContainer): FakeContainer {
      child.removeFromParent();
      child.parent = this;
      this.children.push(child);
      return child;
    }
    removeFromParent(): void {
      if (this.parent === null) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
    destroy(options?: unknown): void {
      this.destroyCalls.push(options);
      this.removeFromParent();
      this.destroyed = true;
      if (state.failViewDestroy && !(this instanceof FakeGraphics)) {
        throw new Error("view destroy failed");
      }
      const wantsChildren = typeof options === "object" && options !== null && "children" in options;
      if (wantsChildren) {
        for (const child of [...this.children]) child.destroy(options);
      }
    }
  }

  class FakeGraphics extends FakeContainer {
    readonly context: FakeGraphicsContext | undefined;
    rectCalls = 0;
    constructor(context?: FakeGraphicsContext) {
      super();
      if (state.failGraphicsCreate) throw new Error("graphics create failed");
      this.context = context;
    }
    get ownsContext(): boolean {
      return this.context === undefined;
    }
    clear(): this {
      return this;
    }
    rect(): this {
      this.rectCalls += 1;
      return this;
    }
    ellipse(): this {
      return this;
    }
    fill(): this {
      return this;
    }
    override destroy(options?: unknown): void {
      if (!this.ownsContext) events.push("graphics.destroy");
      super.destroy(options);
    }
  }

  type Listener = (...args: never[]) => void;

  class FakeCanvas {
    listeners = new Map<string, Listener[]>();
    removed = false;
    parentNode: object | null = {};
    removeEventListenerCalls: string[] = [];
    addEventListener(name: string, listener: Listener): void {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    removeEventListener(name: string, listener: Listener): void {
      this.removeEventListenerCalls.push(name);
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter((candidate) => candidate !== listener),
      );
    }
    remove(): void {
      this.removed = true;
    }
  }

  class FakeApplication {
    initOptions: Record<string, unknown> | null = null;
    destroyCalls: unknown[][] = [];
    canvas = new FakeCanvas();
    stage = new FakeContainer();
    screen = { width: state.screenWidth, height: state.screenHeight };
    rendererListeners = new Map<string, Listener[]>();
    tickerCallbacks: ((ticker: { deltaMS: number }) => void)[] = [];
    tickerRemoveCalls = 0;
    tickerStarted = true;
    renderer = {
      on: (name: string, listener: Listener): void => {
        this.rendererListeners.set(name, [...(this.rendererListeners.get(name) ?? []), listener]);
      },
      off: (name: string, listener: Listener): void => {
        if (state.failRendererOff) throw new Error("off failed");
        this.rendererListeners.set(
          name,
          (this.rendererListeners.get(name) ?? []).filter((candidate) => candidate !== listener),
        );
      },
    };
    ticker = {
      maxFPS: 0,
      stop: (): void => {
        this.tickerStarted = false;
      },
      start: (): void => {
        this.tickerStarted = true;
      },
      add: (callback: (ticker: { deltaMS: number }) => void): void => {
        this.tickerCallbacks.push(callback);
      },
      remove: (callback: (ticker: { deltaMS: number }) => void): void => {
        this.tickerRemoveCalls += 1;
        if (state.failTickerRemove) throw new Error("ticker remove failed");
        this.tickerCallbacks = this.tickerCallbacks.filter((candidate) => candidate !== callback);
      },
    };
    constructor() {
      registry.apps.push(this);
    }
    async init(options: Record<string, unknown>): Promise<void> {
      this.initOptions = options;
      this.screen.width = state.screenWidth;
      this.screen.height = state.screenHeight;
      await state.initImpl();
    }
    destroy(...args: unknown[]): void {
      this.destroyCalls.push(args);
      events.push("app.destroy");
    }
  }

  const registry = {
    apps: [] as FakeApplication[],
    containers: [] as FakeContainer[],
    contexts: [] as FakeGraphicsContext[],
  };

  return {
    events,
    state,
    registry,
    FakeApplication,
    FakeContainer,
    FakeGraphics,
    FakeGraphicsContext,
  };
});

vi.mock("pixi.js", () => ({
  Application: h.FakeApplication,
  Container: h.FakeContainer,
  Graphics: h.FakeGraphics,
  GraphicsContext: h.FakeGraphicsContext,
}));
vi.mock("pixi.js/unsafe-eval", () => ({}));

function makeHost(): { host: HTMLElement; appendChild: ReturnType<typeof vi.fn> } {
  const appendChild = vi.fn();
  return { host: { appendChild } as unknown as HTMLElement, appendChild };
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
    dayPhase: 0,
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

function ticks(count: number, deltaMS = 250): void {
  for (let index = 0; index < count; index += 1) tick(deltaMS);
}

function indexSize(engine: TerrariumEngine): number {
  const internals = engine as unknown as { plantIndex: Map<string, unknown> };
  return internals.plantIndex.size;
}

function seededRandom(seed = 7): () => number {
  let value = seed;
  return () => {
    value = (value * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return value / 4_294_967_296;
  };
}

function lastApp(): InstanceType<typeof h.FakeApplication> {
  const app = h.registry.apps[h.registry.apps.length - 1];
  if (app === undefined) throw new Error("no fake app was created");
  return app;
}

function tick(deltaMS: number): void {
  const callback = lastApp().tickerCallbacks[0];
  if (callback === undefined) throw new Error("no ticker callback registered");
  callback({ deltaMS });
}

function plantLayer(): InstanceType<typeof h.FakeContainer> {
  const layer = lastApp().stage.children[2];
  if (layer === undefined) throw new Error("no plant layer");
  return layer;
}

async function startEngine(
  options: ConstructorParameters<typeof TerrariumEngine>[0] = {},
): Promise<TerrariumEngine> {
  const engine = new TerrariumEngine({ resolution: 1, random: seededRandom(), ...options });
  const ok = await engine.init(makeHost().host);
  expect(ok).toBe(true);
  return engine;
}

let restoreLog: () => void;
let unhandled: unknown[];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  h.events.length = 0;
  h.registry.apps.length = 0;
  h.registry.containers.length = 0;
  h.registry.contexts.length = 0;
  h.state.initImpl = () => Promise.resolve();
  h.state.failGraphicsCreate = false;
  h.state.failViewDestroy = false;
  h.state.failTickerRemove = false;
  h.state.failRendererOff = false;
  h.state.failContextDestroy = false;
  h.state.screenWidth = 800;
  h.state.screenHeight = 600;
  restoreLog = setLogSinkForTesting(() => undefined);
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  restoreLog();
});

describe("init and state machine", () => {
  it("passes the expected options and wires one ticker callback and listeners", async () => {
    const { host, appendChild } = makeHost();
    const engine = new TerrariumEngine({ resolution: 1.5 });
    expect(await engine.init(host)).toBe(true);
    const app = lastApp();
    expect(app.initOptions).toMatchObject({
      resizeTo: host,
      autoDensity: true,
      resolution: 1.5,
      preference: "webgl",
    });
    expect(appendChild).toHaveBeenCalledWith(app.canvas);
    expect(app.tickerCallbacks).toHaveLength(1);
    expect(app.rendererListeners.get("resize")).toHaveLength(1);
    expect(app.canvas.listeners.get("webglcontextlost")).toHaveLength(1);
    expect(app.canvas.listeners.get("webglcontextrestored")).toHaveLength(1);
    engine.destroy();
  });

  it("caps the ticker at 60 FPS", async () => {
    const engine = await startEngine();
    expect(lastApp().ticker.maxFPS).toBe(60);
    engine.destroy();
  });

  it("stops and restarts the ticker with setPaused, including a value set before init", async () => {
    const early = new TerrariumEngine({ resolution: 1 });
    early.setPaused(true);
    expect(await early.init(makeHost().host)).toBe(true);
    expect(lastApp().tickerStarted).toBe(false);
    early.setPaused(false);
    expect(lastApp().tickerStarted).toBe(true);
    early.destroy();

    const engine = await startEngine();
    engine.setPaused(true);
    expect(lastApp().tickerStarted).toBe(false);
    engine.destroy();
    expect(() => {
      engine.setPaused(false);
    }).not.toThrow();
  });

  it("returns false for a second init and after destroy", async () => {
    const engine = await startEngine();
    expect(await engine.init(makeHost().host)).toBe(false);
    engine.destroy();
    expect(await engine.init(makeHost().host)).toBe(false);
    expect(h.registry.apps).toHaveLength(1);
  });

  it("rejects with RenderInitError when app.init fails", async () => {
    h.state.initImpl = () => Promise.reject(new Error("no webgl"));
    const engine = new TerrariumEngine({ resolution: 1 });
    await expect(engine.init(makeHost().host)).rejects.toBeInstanceOf(RenderInitError);
    expect(await engine.init(makeHost().host)).toBe(false);
  });

  it("keeps values set before running and applies them", async () => {
    const engine = new TerrariumEngine({ resolution: 1, random: seededRandom() });
    engine.setDimmed(true);
    engine.setEnvironment(envWith({ postsPerMinute: 80 }));
    engine.addPlant(makeSeed(1));
    expect(engine.getStats().queued).toBe(1);
    expect(await engine.init(makeHost().host)).toBe(true);
    const overlay = lastApp().stage.children.at(-1);
    expect(overlay?.alpha).toBeGreaterThan(0);
    tick(250);
    expect(engine.getStats().plants).toBe(1);
    engine.destroy();
  });

  it("destroy during init destroys the app after init resolves and creates no shared contexts", async () => {
    let resolveInit: () => void = () => undefined;
    h.state.initImpl = () =>
      new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
    const { host, appendChild } = makeHost();
    const engine = new TerrariumEngine({ resolution: 1 });
    const pending = engine.init(host);
    engine.destroy();
    expect(lastApp().destroyCalls).toHaveLength(0);
    resolveInit();
    expect(await pending).toBe(false);
    expect(lastApp().destroyCalls).toEqual([[{ removeView: true }, { children: true }]]);
    expect(h.registry.contexts).toHaveLength(0);
    expect(appendChild).not.toHaveBeenCalled();
    expect(lastApp().tickerCallbacks).toHaveLength(0);
  });

  it("init rejection after destroy resolves false without an unhandled rejection", async () => {
    let rejectInit: (reason: Error) => void = () => undefined;
    h.state.initImpl = () =>
      new Promise<void>((_resolve, reject) => {
        rejectInit = reject;
      });
    const engine = new TerrariumEngine({ resolution: 1 });
    const pending = engine.init(makeHost().host);
    engine.destroy();
    rejectInit(new Error("late failure"));
    expect(await pending).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
  });
});

describe("spawn queue", () => {
  it("drops the oldest seed when the queue overflows", async () => {
    const engine = new TerrariumEngine({ resolution: 1, random: seededRandom() });
    for (let index = 0; index <= PLANT.SPAWN_QUEUE_LIMIT; index += 1) engine.addPlant(makeSeed(index));
    expect(engine.getStats().queued).toBe(PLANT.SPAWN_QUEUE_LIMIT);
    expect(await engine.init(makeHost().host)).toBe(true);
    tick(250);
    const firstPlant = plantLayer().children[0];
    const tints = firstPlant?.children.map((child) => child.tint) ?? [];
    expect(tints).toContain(0x100000 + 1);
    expect(tints).not.toContain(0x100000);
    engine.destroy();
  });

  it("spawns at most one plant per frame regardless of delta", async () => {
    const engine = await startEngine();
    for (let index = 0; index < 20; index += 1) engine.addPlant(makeSeed(index));
    tick(250);
    expect(engine.getStats().plants).toBe(1);
    expect(engine.getStats().queued).toBe(19);
    engine.destroy();
  });

  it("clearPending empties the queue", async () => {
    const engine = await startEngine();
    for (let index = 0; index < 5; index += 1) engine.addPlant(makeSeed(index));
    engine.clearPending();
    expect(engine.getStats().queued).toBe(0);
    engine.destroy();
  });

  it("fadeOutAll clears the queue and fades every living plant out, then destroys them", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.applySettings(settingsWith({ plantLifetimeMs: 600_000 }));
    for (let index = 0; index < 4; index += 1) {
      engine.addPlant(makeSeed(index));
      tick(250);
    }
    for (let index = 10; index < 15; index += 1) engine.addPlant(makeSeed(index));
    expect(engine.getStats().plants).toBe(4);
    const views = [...plantLayer().children];
    engine.fadeOutAll(1_000);
    expect(engine.getStats().queued).toBe(0);
    expect(indexSize(engine)).toBe(4);
    tick(250);
    for (const view of views) {
      expect(view.destroyed).toBe(false);
      expect(view.alpha).toBeLessThan(1);
    }
    tick(250);
    tick(250);
    tick(250);
    tick(250);
    expect(engine.getStats().plants).toBe(0);
    expect(indexSize(engine)).toBe(0);
    for (const view of views) expect(view.destroyed).toBe(true);

    engine.addPlant(makeSeed(100));
    tick(250);
    expect(engine.getStats().plants).toBe(1);
    expect(plantLayer().children[0]?.destroyed).toBe(false);
    ticks(8);
    expect(engine.getStats().plants).toBe(1);
    engine.destroy();
    expect(() => {
      engine.fadeOutAll(1_000);
    }).not.toThrow();
    expect(indexSize(engine)).toBe(0);
  });
});

describe("plant cap and lifetime", () => {
  it("never exceeds MAX_PLANTS and fades then destroys the oldest", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    for (let index = 0; index < PLANT.MAX_PLANTS; index += 1) {
      engine.addPlant(makeSeed(index));
      tick(250);
    }
    expect(engine.getStats().plants).toBe(PLANT.MAX_PLANTS);
    const oldest = plantLayer().children[0];
    if (oldest === undefined) throw new Error("expected a plant");

    engine.addPlant(makeSeed(1_000));
    tick(250);
    expect(engine.getStats().plants).toBe(PLANT.MAX_PLANTS);
    expect(oldest.alpha).toBeCloseTo(0.75);
    expect(oldest.destroyed).toBe(false);
    tick(250);
    tick(250);
    expect(oldest.destroyed).toBe(false);
    expect(oldest.alpha).toBeCloseTo(0.25);
    tick(250);
    expect(oldest.destroyed).toBe(true);
    expect(engine.getStats().plants).toBe(PLANT.MAX_PLANTS - 1);

    for (let index = 0; index < 600; index += 1) {
      engine.addPlant(makeSeed(2_000 + index));
      tick(250);
      expect(engine.getStats().plants).toBeLessThanOrEqual(PLANT.MAX_PLANTS);
    }
    engine.destroy();
  });

  it("destroys a plant when its lifetime ends", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.addPlant(makeSeed(1));
    tick(250);
    const view = plantLayer().children[0];
    expect(engine.getStats().plants).toBe(1);
    const lifeTicks = PLANT.LIFETIME_MS / 250;
    for (let index = 0; index < lifeTicks - 2; index += 1) tick(250);
    expect(view?.destroyed).toBe(false);
    for (let index = 0; index < 4; index += 1) tick(250);
    expect(engine.getStats().plants).toBe(0);
    expect(view?.destroyed).toBe(true);
    expect(plantLayer().children).toHaveLength(0);
    engine.destroy();
  });

  it("clamps invalid seed values instead of throwing", async () => {
    const engine = await startEngine();
    engine.addPlant({ ...makeSeed(1), scale: Number.NaN, growthDurationMs: Number.NaN, color: Number.NaN });
    expect(() => {
      tick(250);
      tick(250);
    }).not.toThrow();
    expect(engine.getStats().plants).toBe(1);
    engine.destroy();
  });

  it("builds mood-specific plants from shared contexts", async () => {
    const engine = await startEngine();
    engine.addPlant(makeSeed(1, "positive"));
    tick(250);
    engine.addPlant(makeSeed(2, "negative"));
    tick(250);
    engine.addPlant(makeSeed(3, "neutral"));
    tick(250);
    const [positive, negative, neutral] = plantLayer().children;
    expect(positive?.children.length).toBeGreaterThanOrEqual(3);
    expect(negative?.children.length).toBeGreaterThanOrEqual(3);
    expect(neutral?.children.length).toBeGreaterThanOrEqual(3);
    engine.destroy();
  });
});

describe("destroy", () => {
  it("removes ticker and listeners, empties state, and later calls are no-ops", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.setEnvironment(envWith({ postsPerMinute: 1_000 }));
    for (let index = 0; index < 5; index += 1) {
      engine.addPlant(makeSeed(index));
      tick(250);
    }
    const app = lastApp();
    const canvas = app.canvas;
    engine.destroy();

    expect(app.tickerRemoveCalls).toBe(1);
    expect(app.tickerCallbacks).toHaveLength(0);
    expect(app.rendererListeners.get("resize")).toHaveLength(0);
    expect(canvas.removeEventListenerCalls).toEqual(["webglcontextlost", "webglcontextrestored"]);
    expect(app.destroyCalls).toEqual([[{ removeView: true }, { children: true }]]);
    expect(canvas.removed).toBe(true);
    expect(engine.getStats()).toEqual({ plants: 0, queued: 0, particles: 0, effectObjects: 0 });

    engine.addPlant(makeSeed(99));
    engine.setEnvironment(envWith({ postsPerMinute: 50 }));
    engine.setDimmed(true);
    engine.clearPending();
    engine.destroy();
    expect(engine.getStats()).toEqual({ plants: 0, queued: 0, particles: 0, effectObjects: 0 });
    expect(app.destroyCalls).toHaveLength(1);
  });

  it("never passes context:true to plants or particles and destroys shared contexts once, after all graphics", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.setEnvironment(envWith({ postsPerMinute: 1_000 }));
    for (let index = 0; index < 10; index += 1) {
      engine.addPlant(makeSeed(index));
      tick(250);
    }
    expect(engine.getStats().particles).toBeGreaterThan(0);
    engine.destroy();

    for (const container of h.registry.containers) {
      const isOwnContextGraphics = container instanceof h.FakeGraphics && container.ownsContext;
      if (isOwnContextGraphics) continue;
      for (const call of container.destroyCalls) {
        expect(call).not.toMatchObject({ context: true });
      }
    }
    for (const context of h.registry.contexts) expect(context.destroyCalls).toBe(1);
    expect(h.registry.contexts.length).toBeGreaterThanOrEqual(6);

    const lastGraphics = h.events.lastIndexOf("graphics.destroy");
    const firstContext = h.events.indexOf("context.destroy");
    const appDestroy = h.events.indexOf("app.destroy");
    expect(lastGraphics).toBeGreaterThanOrEqual(0);
    expect(firstContext).toBeGreaterThan(lastGraphics);
    expect(appDestroy).toBeGreaterThan(h.events.lastIndexOf("context.destroy"));
  });

  it("still reaches app.destroy when teardown steps throw", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.addPlant(makeSeed(1));
    tick(250);
    const app = lastApp();
    h.state.failTickerRemove = true;
    h.state.failRendererOff = true;
    h.state.failViewDestroy = true;
    h.state.failContextDestroy = true;
    expect(() => {
      engine.destroy();
    }).not.toThrow();
    expect(app.destroyCalls).toHaveLength(1);
    expect(engine.getStats().plants).toBe(0);
  });
});

describe("update robustness and particles", () => {
  it("does not let an exception inside the particle update escape the ticker callback", async () => {
    const engine = await startEngine();
    engine.setEnvironment(envWith({ postsPerMinute: 1_000 }));
    h.state.failGraphicsCreate = true;
    expect(() => {
      tick(250);
      tick(250);
    }).not.toThrow();
    h.state.failGraphicsCreate = false;
    engine.addPlant(makeSeed(1));
    tick(250);
    expect(engine.getStats().plants).toBe(1);
    engine.destroy();
  });

  it("keeps the particle count bounded and spawns at most one per frame", async () => {
    const engine = await startEngine({ random: () => 1 });
    engine.setEnvironment(envWith({ postsPerMinute: 100_000 }));
    let previous = 0;
    for (let index = 0; index < 3_000; index += 1) {
      tick(250);
      const { particles } = engine.getStats();
      expect(particles).toBeLessThanOrEqual(PARTICLES.MAX_PARTICLES);
      expect(particles - previous).toBeLessThanOrEqual(1);
      previous = particles;
    }
    expect(previous).toBeGreaterThan(0);
    engine.destroy();
  });

  it("spawns no particles below the activity threshold and clears them when quiet", async () => {
    const engine = await startEngine();
    engine.setEnvironment(envWith({ postsPerMinute: PARTICLES.THRESHOLD_PPM - 1 }));
    for (let index = 0; index < 200; index += 1) tick(250);
    expect(engine.getStats().particles).toBe(0);
    engine.setEnvironment(envWith({ postsPerMinute: 100 }));
    for (let index = 0; index < 400; index += 1) tick(250);
    expect(engine.getStats().particles).toBeGreaterThan(0);
    engine.clearPending();
    for (let index = 0; index < 1_200; index += 1) tick(250);
    expect(engine.getStats().particles).toBe(0);
    engine.destroy();
  });

  it("ignores non-finite deltas", async () => {
    const engine = await startEngine();
    engine.addPlant(makeSeed(1));
    expect(() => {
      tick(Number.NaN);
      tick(250);
    }).not.toThrow();
    engine.destroy();
  });
});

describe("resize and context loss", () => {
  it("repositions plants by xRatio and redraws the background on resize", async () => {
    const engine = await startEngine({ random: seededRandom(3) });
    for (let index = 0; index < 5; index += 1) {
      engine.addPlant(makeSeed(index));
      tick(250);
    }
    const app = lastApp();
    const plants = plantLayer().children;
    const before = plants.map((plant) => plant.position.x);
    const background = h.registry.containers.find(
      (container): container is InstanceType<typeof h.FakeGraphics> =>
        container instanceof h.FakeGraphics && container.ownsContext,
    );
    const rectsBefore = background?.rectCalls ?? 0;

    app.screen.width = 400;
    app.screen.height = 300;
    for (const listener of app.rendererListeners.get("resize") ?? []) listener();
    const after = plants.map((plant) => plant.position.x);
    after.forEach((x, index) => {
      expect(x).toBeCloseTo((before[index] ?? 0) / 2);
    });
    expect(background?.rectCalls ?? 0).toBeGreaterThan(rectsBefore);

    const rectsAfter = background?.rectCalls ?? 0;
    app.screen.width = 0;
    for (const listener of app.rendererListeners.get("resize") ?? []) listener();
    expect(plants.map((plant) => plant.position.x)).toEqual(after);
    expect(background?.rectCalls).toBe(rectsAfter);
    engine.destroy();
  });

  it("reports a lost WebGL context once", async () => {
    const onContextLost = vi.fn();
    const engine = await startEngine({ onContextLost });
    const preventDefault = vi.fn();
    const handlers = lastApp().canvas.listeners.get("webglcontextlost") ?? [];
    for (let index = 0; index < 2; index += 1) {
      for (const handler of handlers) (handler as unknown as (event: Event) => void)({ preventDefault } as unknown as Event);
    }
    expect(onContextLost).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    engine.destroy();
  });
});

function backgroundGraphics(): InstanceType<typeof h.FakeGraphics> {
  const background = h.registry.containers.find(
    (container): container is InstanceType<typeof h.FakeGraphics> =>
      container instanceof h.FakeGraphics && container.ownsContext,
  );
  if (background === undefined) throw new Error("no background");
  return background;
}

describe("environment effects", () => {
  it("keeps a single ticker callback with every effect running", async () => {
    const engine = await startEngine();
    engine.setEnvironment(
      envWith({ rain: 1, fog: 1, fireflies: 1, light: 1, wind: 1, postsPerMinute: 100 }),
    );
    ticks(60);
    expect(lastApp().tickerCallbacks).toHaveLength(1);
    expect(engine.getStats().effectObjects).toBeGreaterThan(0);
    engine.destroy();
  });

  it("builds rain gradually, never above RAIN_MAX_DROPS, and keeps the count steady", async () => {
    const engine = await startEngine({ random: seededRandom(5) });
    engine.setEnvironment(envWith({ rain: 1 }));
    let previous = 0;
    for (let index = 0; index < 400; index += 1) {
      tick(16);
      const count = engine.getStats().effectObjects;
      expect(count).toBeLessThanOrEqual(EFFECTS.RAIN_MAX_DROPS + 1);
      expect(count - previous).toBeLessThanOrEqual(11);
      previous = count;
    }
    const settled = engine.getStats().effectObjects;
    expect(settled).toBeGreaterThan(100);
    ticks(400, 16);
    // Drops are recycled when they land: the count does not grow further.
    expect(engine.getStats().effectObjects).toBeLessThanOrEqual(EFFECTS.RAIN_MAX_DROPS + 1);
    engine.destroy();
  });

  it("releases rain once rain stops or the toggle is off", async () => {
    const engine = await startEngine({ random: seededRandom(6) });
    engine.setEnvironment(envWith({ rain: 1 }));
    ticks(200, 16);
    expect(engine.getStats().effectObjects).toBeGreaterThan(0);
    engine.applySettings(settingsWith({}, { rain: false }));
    ticks(400, 16);
    expect(engine.getStats().effectObjects).toBe(0);

    engine.applySettings(settingsWith());
    ticks(200, 16);
    expect(engine.getStats().effectObjects).toBeGreaterThan(0);
    engine.setEnvironment(envWith({ rain: 0 }));
    ticks(1_500, 16);
    expect(engine.getStats().effectObjects).toBe(0);
    engine.destroy();
  });

  it("scales the rain density with particleIntensity but never past the cap", async () => {
    const half = await startEngine({ random: seededRandom(7) });
    half.applySettings(settingsWith({ particleIntensity: 0.5 }));
    half.setEnvironment(envWith({ rain: 1 }));
    ticks(400, 16);
    const halfCount = half.getStats().effectObjects;
    half.destroy();

    const doubled = await startEngine({ random: seededRandom(7) });
    doubled.applySettings(settingsWith({ particleIntensity: 2 }));
    doubled.setEnvironment(envWith({ rain: 0.5 }));
    ticks(400, 16);
    const doubledCount = doubled.getStats().effectObjects;
    doubled.destroy();

    expect(halfCount).toBeGreaterThan(0);
    expect(halfCount).toBeLessThan(doubledCount);
    expect(doubledCount).toBeLessThanOrEqual(EFFECTS.RAIN_MAX_DROPS + 1);
  });

  it("caps fog banks and fades them out when disabled", async () => {
    const engine = await startEngine({ random: seededRandom(8) });
    engine.setEnvironment(envWith({ fog: 1 }));
    tick(250);
    expect(engine.getStats().effectObjects).toBeLessThanOrEqual(2); // smoothing: not all banks at once
    ticks(200);
    expect(engine.getStats().effectObjects).toBe(EFFECTS.FOG_MAX_SPRITES);
    engine.applySettings(settingsWith({}, { fog: false }));
    ticks(120);
    expect(engine.getStats().effectObjects).toBe(0);
    engine.destroy();
  });

  it("caps fireflies and releases them when disabled", async () => {
    const engine = await startEngine({ random: seededRandom(9) });
    engine.setEnvironment(envWith({ fireflies: 1 }));
    for (let index = 0; index < 400; index += 1) {
      tick(250);
      expect(engine.getStats().effectObjects).toBeLessThanOrEqual(EFFECTS.FIREFLIES_MAX);
    }
    expect(engine.getStats().effectObjects).toBe(EFFECTS.FIREFLIES_MAX);
    engine.applySettings(settingsWith({}, { fireflies: false }));
    ticks(400);
    expect(engine.getStats().effectObjects).toBe(0);
    engine.destroy();
  });

  it("respects the light particle toggle and intensity", async () => {
    const engine = await startEngine({ random: () => 0.3 });
    engine.applySettings(settingsWith({ particleIntensity: 0 }));
    engine.setEnvironment(envWith({ postsPerMinute: 200 }));
    ticks(200);
    expect(engine.getStats().particles).toBe(0);

    engine.applySettings(settingsWith());
    ticks(200);
    expect(engine.getStats().particles).toBeGreaterThan(0);
    engine.applySettings(settingsWith({}, { lightParticles: false }));
    ticks(60);
    expect(engine.getStats().particles).toBe(0);
    engine.destroy();
  });

  it("shows the light overlay only when weather.light is positive", async () => {
    const engine = await startEngine();
    ticks(20);
    expect(engine.getStats().effectObjects).toBe(0);
    engine.setEnvironment(envWith({ light: 1 }));
    ticks(60);
    expect(engine.getStats().effectObjects).toBe(1);
    engine.destroy();
  });

  it("adds halos to positive plants only while bloom is on and releases them after", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.addPlant(makeSeed(1, "positive"));
    tick(250);
    engine.addPlant(makeSeed(2, "negative"));
    tick(250);
    tick(250);
    const [positive, negative] = plantLayer().children;
    const withHalo = positive?.children.length ?? 0;
    expect(engine.getStats().effectObjects).toBe(1);
    expect(negative?.children.length).toBeLessThan(withHalo);

    engine.applySettings(settingsWith({}, { bloom: false }));
    ticks(60);
    expect(engine.getStats().effectObjects).toBe(0);
    expect(positive?.children.length).toBe(withHalo - 1);

    engine.applySettings(settingsWith());
    tick(250);
    expect(engine.getStats().effectObjects).toBe(1);
    expect(positive?.children.length).toBe(withHalo);
    engine.destroy();
  });

  it("drops the halo reference when its plant is destroyed", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.applySettings(settingsWith({ plantLifetimeMs: 60_000 }));
    engine.addPlant(makeSeed(1, "positive"));
    tick(250);
    tick(250);
    expect(engine.getStats().effectObjects).toBe(1);
    ticks(300);
    expect(engine.getStats().plants).toBe(0);
    expect(engine.getStats().effectObjects).toBe(0);
    engine.destroy();
  });

  it("does not let a failing effect break the ticker or the plants", async () => {
    const engine = await startEngine();
    engine.setEnvironment(envWith({ rain: 1, fog: 1, fireflies: 1, postsPerMinute: 100 }));
    h.state.failGraphicsCreate = true;
    expect(() => {
      ticks(10);
    }).not.toThrow();
    h.state.failGraphicsCreate = false;
    engine.addPlant(makeSeed(1));
    tick(250);
    expect(engine.getStats().plants).toBe(1);
    engine.destroy();
  });
});

describe("environment smoothing and palette", () => {
  it("smooths weather towards the target instead of jumping", async () => {
    const engine = await startEngine({ random: seededRandom(2) });
    engine.setEnvironment(envWith({ fog: 1 }));
    tick(250);
    const early = engine.getStats().effectObjects;
    ticks(300);
    const late = engine.getStats().effectObjects;
    expect(early).toBeLessThan(late);
    engine.destroy();
  });

  it("redraws the background only when the palette changes", async () => {
    const engine = await startEngine();
    const background = backgroundGraphics();
    ticks(40);
    const rectsSteady = background.rectCalls;
    ticks(80);
    expect(background.rectCalls).toBe(rectsSteady);

    engine.setEnvironment(envWith({}, { dayPhase: 0.5 }));
    ticks(40);
    expect(background.rectCalls).toBeGreaterThan(rectsSteady);

    const rectsDay = background.rectCalls;
    ticks(80);
    expect(background.rectCalls).toBe(rectsDay);
    engine.destroy();
  });

  it("does not redraw for the day phase when the day/night cycle is off", async () => {
    const engine = await startEngine();
    engine.applySettings(settingsWith({}, { dayNightCycle: false, climate: false }));
    ticks(20);
    const background = backgroundGraphics();
    const before = background.rectCalls;
    engine.setEnvironment(envWith({}, { dayPhase: 0.5, climate: "darkForest" }));
    ticks(60);
    expect(background.rectCalls).toBe(before);
    engine.destroy();
  });

  it("ignores invalid environment values", async () => {
    const engine = await startEngine();
    expect(() => {
      engine.setEnvironment(
        envWith({ rain: Number.NaN, fog: 5, wind: -3 }, { dayPhase: Number.NaN }),
      );
      ticks(20);
    }).not.toThrow();
    expect(engine.getStats().effectObjects).toBeLessThanOrEqual(EFFECTS.FOG_MAX_SPRITES);
    engine.destroy();
  });
});

describe("applySettings", () => {
  it("applies values set before init", async () => {
    const engine = new TerrariumEngine({ resolution: 1, random: () => 0.5 });
    engine.applySettings(settingsWith({ maxPlants: 50 }));
    for (let index = 0; index < 60; index += 1) engine.addPlant(makeSeed(index));
    expect(await engine.init(makeHost().host)).toBe(true);
    for (let index = 0; index < 200; index += 1) tick(250);
    expect(engine.getStats().plants).toBeLessThanOrEqual(50);
    engine.destroy();
  });

  it("lowers maxPlants gradually, at most SPAWN_PER_SECOND per second, never in one frame", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    for (let index = 0; index < 100; index += 1) {
      engine.addPlant(makeSeed(index));
      tick(250);
    }
    expect(engine.getStats().plants).toBe(100);
    engine.applySettings(settingsWith({ maxPlants: 50 }));
    let elapsedMs = 0;
    while (engine.getStats().plants > 50 && elapsedMs < 60_000) {
      tick(250);
      elapsedMs += 250;
      const removed = 100 - engine.getStats().plants;
      expect(removed).toBeLessThanOrEqual(PLANT.SPAWN_PER_SECOND * Math.ceil(elapsedMs / 1_000));
    }
    expect(engine.getStats().plants).toBe(50);
    expect(elapsedMs).toBeGreaterThanOrEqual(10_000);
    // The cap now holds for new plants too.
    for (let index = 0; index < 20; index += 1) {
      engine.addPlant(makeSeed(1_000 + index));
      tick(250);
      expect(engine.getStats().plants).toBeLessThanOrEqual(50);
    }
    engine.destroy();
  });

  it("clamps maxPlants into the allowed range", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.applySettings(settingsWith({ maxPlants: 100_000 }));
    for (let index = 0; index < PLANT.MAX_PLANTS + 20; index += 1) {
      engine.addPlant(makeSeed(index));
      tick(250);
      expect(engine.getStats().plants).toBeLessThanOrEqual(PLANT.MAX_PLANTS);
    }
    expect(() => {
      engine.applySettings(settingsWith({ maxPlants: Number.NaN, animationSpeed: Number.NaN }));
      tick(250);
    }).not.toThrow();
    engine.destroy();
  });

  it("applies plantLifetimeMs to new plants only", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.addPlant(makeSeed(1));
    tick(250);
    const first = plantLayer().children[0];
    engine.applySettings(settingsWith({ plantLifetimeMs: 60_000 }));
    engine.addPlant(makeSeed(2));
    tick(250);
    const second = plantLayer().children[1];
    ticks(280); // about 70 s
    expect(second?.destroyed).toBe(true);
    expect(first?.destroyed).toBe(false);
    expect(engine.getStats().plants).toBe(1);
    engine.destroy();
  });

  it("animationSpeed speeds up growth but not the lifetime", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.applySettings(settingsWith({ animationSpeed: 2 }));
    engine.addPlant({ ...makeSeed(1), scale: 1.5, growthDurationMs: 1_000 });
    tick(250);
    tick(250);
    tick(250);
    const view = plantLayer().children[0];
    // growth age 1.5 s >= 1 s at 2x, but only 0.75 s of real time has passed.
    expect(view?.scale.x).toBeCloseTo(1.5);
    ticks(300); // about 75 s
    expect(view?.destroyed).toBe(false);
    ticks(500); // about 200 s
    expect(view?.destroyed).toBe(true);
    engine.destroy();
  });
});

describe("growPlant", () => {
  it("ignores unknown ids and invalid scales without throwing", async () => {
    const engine = await startEngine();
    expect(() => {
      engine.growPlant("missing", 2);
      engine.growPlant("missing", Number.NaN);
    }).not.toThrow();
    engine.addPlant(makeSeed(1));
    tick(250);
    expect(() => {
      engine.growPlant("plant-1", Number.NaN);
      engine.growPlant("plant-1", Number.POSITIVE_INFINITY);
    }).not.toThrow();
    engine.destroy();
  });

  it("raises a living plant smoothly and never shrinks it", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    engine.addPlant({ ...makeSeed(1), scale: 1, growthDurationMs: 1_000 });
    ticks(8);
    const view = plantLayer().children[0];
    expect(view?.scale.x).toBeCloseTo(1);

    engine.growPlant("plant-1", 2);
    tick(250);
    const early = view?.scale.x ?? 0;
    expect(early).toBeGreaterThan(1);
    expect(early).toBeLessThan(2);
    ticks(40);
    expect(view?.scale.x).toBeCloseTo(2, 1);

    engine.growPlant("plant-1", 1.2);
    ticks(20);
    expect(view?.scale.x).toBeCloseTo(2, 1);
    engine.growPlant("plant-1", 100);
    ticks(80);
    expect(view?.scale.x).toBeCloseTo(PLANT.SCALE_MAX, 1);
    engine.destroy();
  });

  it("raises a queued seed before it spawns", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    for (let index = 0; index < 3; index += 1) engine.addPlant({ ...makeSeed(index), scale: 1 });
    engine.growPlant("plant-2", 2);
    ticks(40);
    const views = plantLayer().children;
    expect(views).toHaveLength(3);
    expect(views[0]?.scale.x).toBeCloseTo(1);
    expect(views[2]?.scale.x).toBeCloseTo(2);
    engine.destroy();
  });

  it("keeps the id map bounded and cleans it on removal, clearPending and destroy", async () => {
    const engine = await startEngine({ random: () => 0.5 });
    for (let index = 0; index < PLANT.SPAWN_QUEUE_LIMIT + 50; index += 1) {
      engine.addPlant(makeSeed(index));
    }
    expect(indexSize(engine)).toBeLessThanOrEqual(PLANT.SPAWN_QUEUE_LIMIT);
    engine.clearPending();
    expect(indexSize(engine)).toBe(0);

    engine.applySettings(settingsWith({ plantLifetimeMs: 60_000 }));
    for (let index = 0; index < 5; index += 1) {
      engine.addPlant(makeSeed(500 + index));
      tick(250);
    }
    expect(indexSize(engine)).toBe(5);
    ticks(300);
    expect(engine.getStats().plants).toBe(0);
    expect(indexSize(engine)).toBe(0);
    engine.growPlant("plant-500", 2); // removed plant: no-op

    for (let index = 0; index < 400; index += 1) {
      engine.addPlant(makeSeed(2_000 + index));
      tick(250);
      expect(indexSize(engine)).toBeLessThanOrEqual(PLANT.MAX_PLANTS + PLANT.SPAWN_QUEUE_LIMIT);
    }
    engine.destroy();
    expect(indexSize(engine)).toBe(0);
    expect(() => {
      engine.growPlant("plant-2000", 2);
    }).not.toThrow();
  });
});

describe("teardown with effects", () => {
  it("destroys every effect object, shared contexts once, and still reaches app.destroy", async () => {
    const engine = await startEngine({ random: seededRandom(11) });
    engine.setEnvironment(
      envWith({ rain: 1, fog: 1, fireflies: 1, light: 1, wind: 1, postsPerMinute: 120 }),
    );
    for (let index = 0; index < 30; index += 1) {
      engine.addPlant(makeSeed(index, index % 2 === 0 ? "positive" : "negative"));
      tick(250);
    }
    ticks(60);
    expect(engine.getStats().effectObjects).toBeGreaterThan(50);
    const app = lastApp();
    engine.destroy();

    expect(app.destroyCalls).toHaveLength(1);
    expect(app.tickerCallbacks).toHaveLength(0);
    expect(engine.getStats()).toEqual({ plants: 0, queued: 0, particles: 0, effectObjects: 0 });
    for (const context of h.registry.contexts) expect(context.destroyCalls).toBe(1);
    for (const container of h.registry.containers) {
      if (container instanceof h.FakeGraphics && !container.ownsContext) {
        expect(container.destroyed).toBe(true);
      }
    }
    for (const container of h.registry.containers) {
      for (const call of container.destroyCalls) {
        const isOwnContextGraphics = container instanceof h.FakeGraphics && container.ownsContext;
        if (!isOwnContextGraphics) expect(call).not.toMatchObject({ context: true });
      }
    }
    expect(h.events.indexOf("app.destroy")).toBeGreaterThan(h.events.lastIndexOf("context.destroy"));
  });

  it("is safe to destroy and recreate repeatedly (StrictMode style)", async () => {
    for (let round = 0; round < 3; round += 1) {
      const engine = await startEngine();
      engine.setEnvironment(envWith({ rain: 1, fog: 1, fireflies: 1 }));
      ticks(20);
      engine.destroy();
      engine.destroy();
    }
    expect(h.registry.apps).toHaveLength(3);
    for (const app of h.registry.apps) expect(app.destroyCalls).toHaveLength(1);
  });
});
