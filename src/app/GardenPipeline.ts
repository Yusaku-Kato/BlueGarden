import { classifyMood } from "../domain/classifyMood";
import { engagement, plantScale } from "../domain/engagement";
import { dayPhaseFromMinutes, deriveClimate, deriveWeather } from "../domain/environment";
import { FlowRateMeter, type FlowSnapshot, type MoodCounts } from "../domain/FlowRateMeter";
import type { EnvironmentState, GardenClimate, GardenPost, MoodClassifier, PlantSeed } from "../domain/models";
import { toPlantSeed } from "../domain/postMapping";
import type { TrendMeter } from "../domain/TrendMeter";
import { errorName, logger } from "../infra/logger";
import { EngagementTracker } from "../services/bluesky/EngagementTracker";
import type { EngagementClient } from "../services/bluesky/engagementClient";
import { isSessionFatal, isTargetFatal, type GardenError, type GardenErrorKind } from "../services/bluesky/errors";
import type { PostBatchMeta, PostSource, PostSourceEvents } from "../services/bluesky/PostSource";
import type { GardenSink } from "./gardenSink";

export interface GardenPipelineOptions {
  /** Builds the source wired to the pipeline's event handlers. Called once, in the constructor. */
  createSource: (events: PostSourceEvents) => PostSource;
  sink: GardenSink;
  /** Owned by the caller (so it can outlive pause/resume and be reset on feed change). */
  trend: TrendMeter;
  /**
   * After-growth re-fetch (SPEC section 13.3). Pass it only for the global source, where posts have
   * little engagement when planted. The pipeline owns the tracker (start / pause / resume / stop).
   */
  engagementClient?: EngagementClient;
  classify?: MoodClassifier;
  now?: () => number;
  /** Local minutes since midnight; the domain never reads the clock itself. */
  localMinutes?: () => number;
  onError: (kind: GardenErrorKind, nextDelayMs: number) => void;
  onRecovered: () => void;
  /** The session is unusable (the owner returns to the login screen). */
  onSessionFatal: (kind: GardenErrorKind) => void;
  /** The current feed is unusable (the session stays; the user picks another feed). */
  onTargetFatal: (kind: GardenErrorKind) => void;
}

/** Advances dayPhase (and decays the trend) when no posts arrive. */
const ENVIRONMENT_INTERVAL_MS = 60_000;

type PipelineState = "idle" | "running" | "paused" | "stopped";

function currentLocalMinutes(): number {
  const date = new Date();
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Wires PostSource -> classifyMood -> toPlantSeed -> GardenSink, and derives the environment
 * (docs/DESIGN.md §6.2, §35.8). Posts exist only inside handlePosts; nothing retains them.
 */
export class GardenPipeline {
  private readonly sink: GardenSink;
  private readonly classify: MoodClassifier;
  private readonly now: () => number;
  private readonly localMinutes: () => number;
  private readonly trend: TrendMeter;
  private readonly flowRate = new FlowRateMeter();
  private readonly source: PostSource;
  private readonly tracker: EngagementTracker | null;
  private readonly options: GardenPipelineOptions;
  private state: PipelineState = "idle";
  private climate: GardenClimate = "temperate";
  private plantCounter = 0;
  private environmentTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: GardenPipelineOptions) {
    this.options = options;
    this.sink = options.sink;
    this.trend = options.trend;
    this.classify = options.classify ?? classifyMood;
    this.now = options.now ?? Date.now;
    this.localMinutes = options.localMinutes ?? currentLocalMinutes;
    this.tracker =
      options.engagementClient === undefined
        ? null
        : new EngagementTracker({
            client: options.engagementClient,
            onUpdate: (token, counts) => {
              this.safeGrowPlant(token, plantScale(engagement(counts.likeCount, counts.repostCount)));
            },
          });
    this.source = options.createSource({
      onPosts: (posts, meta) => {
        this.handlePosts(posts, meta);
      },
      onError: (error, nextDelayMs) => {
        options.onError(error.kind, nextDelayMs);
      },
      onRecovered: options.onRecovered,
      onFatal: (error) => {
        this.handleFatal(error);
      },
    });
  }

  start(): void {
    if (this.state !== "idle") return;
    this.state = "running";
    this.safeSetEnvironment(this.calmEnvironment());
    this.startEnvironmentTimer();
    this.tracker?.start();
    this.source.start();
  }

  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.clearEnvironmentTimer();
    this.tracker?.pause();
    this.source.pause();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    this.emitEnvironment();
    this.startEnvironmentTimer();
    this.tracker?.resume();
    this.source.resume();
  }

  /** Idempotent. Stops the source and timers and calms the environment. */
  stop(): void {
    const wasStopped = this.state === "stopped";
    this.state = "stopped";
    this.clearEnvironmentTimer();
    this.tracker?.stop();
    this.source.stop();
    this.flowRate.reset();
    if (!wasStopped) this.safeSetEnvironment(this.calmEnvironment());
  }

  private handleFatal(error: GardenError): void {
    this.state = "stopped";
    this.clearEnvironmentTimer();
    this.tracker?.stop();
    this.flowRate.reset();
    this.safeSetEnvironment(this.calmEnvironment());
    if (isSessionFatal(error.kind)) this.options.onSessionFatal(error.kind);
    else if (isTargetFatal(error.kind)) this.options.onTargetFatal(error.kind);
    else logger.warn("pipeline.unroutedFatal", { kind: error.kind });
  }

  private handlePosts(posts: readonly GardenPost[], meta: PostBatchMeta): void {
    if (this.state === "stopped") return;
    let positive = 0;
    let negative = 0;
    let neutral = 0;
    for (const post of posts) {
      const seed = this.createSeed(post);
      if (seed === null) continue;
      if (seed.mood === "positive") positive += 1;
      else if (seed.mood === "negative") negative += 1;
      else neutral += 1;
      this.safeAddPlant(seed);
      this.tracker?.track(post.uri, seed.id);
    }
    const moods: MoodCounts = { positive, negative, neutral };
    this.flowRate.record(this.now(), meta.activityCount, moods);
    this.emitEnvironment();
  }

  private createSeed(post: GardenPost): PlantSeed | null {
    try {
      const mood = this.classify(post.text);
      this.plantCounter += 1;
      return toPlantSeed(post, mood, `plant-${String(this.plantCounter)}`);
    } catch (error) {
      logger.error("unexpected", { where: "createSeed", error: errorName(error) });
      return null;
    }
  }

  private emitEnvironment(): void {
    try {
      const nowMs = this.now();
      const snapshot: FlowSnapshot = this.flowRate.snapshot(nowMs);
      this.trend.update(nowMs, snapshot);
      const dayPhase = dayPhaseFromMinutes(this.localMinutes());
      this.climate = deriveClimate(this.trend.value(), this.climate);
      this.safeSetEnvironment({
        weather: deriveWeather(snapshot, dayPhase),
        dayPhase,
        climate: this.climate,
      });
    } catch (error) {
      logger.error("unexpected", { where: "emitEnvironment", error: errorName(error) });
    }
  }

  private calmEnvironment(): EnvironmentState {
    this.climate = "temperate";
    return {
      weather: deriveWeather({ postsPerMinute: 0, positiveShare: 0, negativeShare: 0 }, 0),
      dayPhase: dayPhaseFromMinutes(this.localMinutes()),
      climate: "temperate",
    };
  }

  private startEnvironmentTimer(): void {
    if (this.environmentTimer !== null) return;
    this.environmentTimer = setInterval(() => {
      this.emitEnvironment();
    }, ENVIRONMENT_INTERVAL_MS);
  }

  private clearEnvironmentTimer(): void {
    if (this.environmentTimer === null) return;
    clearInterval(this.environmentTimer);
    this.environmentTimer = null;
  }

  private safeAddPlant(seed: PlantSeed): void {
    try {
      this.sink.addPlant(seed);
    } catch (error) {
      logger.error("unexpected", { where: "sink.addPlant", error: errorName(error) });
    }
  }

  private safeGrowPlant(id: string, targetScale: number): void {
    try {
      this.sink.growPlant(id, targetScale);
    } catch (error) {
      logger.error("unexpected", { where: "sink.growPlant", error: errorName(error) });
    }
  }

  private safeSetEnvironment(environment: EnvironmentState): void {
    try {
      this.sink.setEnvironment(environment);
    } catch (error) {
      logger.error("unexpected", { where: "sink.setEnvironment", error: errorName(error) });
    }
  }
}
