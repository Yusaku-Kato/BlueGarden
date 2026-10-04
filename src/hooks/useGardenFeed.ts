import { useEffect, useRef, useState } from "react";
import { createPostSource, type PostSourceAccess } from "../app/createPostSource";
import type { DisplayError } from "../app/displayErrors";
import { GardenPipeline } from "../app/GardenPipeline";
import type { FeedTarget } from "../domain/models";
import { parseFeedTarget } from "../domain/settings";
import { TrendMeter } from "../domain/TrendMeter";
import { FEED_SWITCH_FADE_MS, type TerrariumRenderer } from "../rendering/TerrariumRenderer";
import type { GardenAccess } from "../services/bluesky/blueskySession";
import type { GardenErrorKind } from "../services/bluesky/errors";

export interface GardenFeedState {
  /** Transient errors (network, rate limit); cleared on recovery. */
  readonly feedError: DisplayError | null;
  /** The current feed cannot be used; stays until the target changes. */
  readonly targetError: DisplayError | null;
}

/**
 * Runs a GardenPipeline while both an access (session or guest) and an engine exist (docs/DESIGN.md sections 9.4, 36.2).
 * The pipeline is recreated whenever the access, the engine or the feed target changes. The
 * long-term trend is reset only when the feed target or the access identity changes, never for an
 * engine swap (2D/3D switch, context-loss recovery, fallback).
 * Pauses while `paused` is true. Session-fatal errors go to `onSessionLost`; target-fatal errors
 * become `targetError` without signing out.
 */
export function useGardenFeed(
  access: GardenAccess | null,
  engine: TerrariumRenderer | null,
  target: FeedTarget,
  onSessionLost: (kind: GardenErrorKind) => void,
  paused: boolean,
): GardenFeedState {
  const [feedError, setFeedError] = useState<DisplayError | null>(null);
  const [targetError, setTargetError] = useState<DisplayError | null>(null);
  const onSessionLostRef = useRef(onSessionLost);
  const pipelineRef = useRef<GardenPipeline | null>(null);
  const pausedRef = useRef(paused);
  const trendRef = useRef(new TrendMeter());
  /** Feed target + access identity the trend currently describes; null while signed out. */
  const trendKeyRef = useRef<string | null>(null);
  /** What the previous run started with; null on first mount and while signed out or engine-less. */
  const previousRunRef = useRef<{ access: GardenAccess; engine: TerrariumRenderer; targetKey: string } | null>(null);

  // Settings objects are replaced on every change; key the effect on the target's content.
  const targetKey = JSON.stringify(target);

  useEffect(() => {
    onSessionLostRef.current = onSessionLost;
  }, [onSessionLost]);

  useEffect(() => {
    if (access === null) trendKeyRef.current = null;
    if (access === null || engine === null) {
      previousRunRef.current = null;
      return;
    }

    // The user switched feeds within the same access and engine: let the old garden fade away.
    const previous = previousRunRef.current;
    if (
      previous !== null &&
      previous.access === access &&
      previous.engine === engine &&
      previous.targetKey !== targetKey
    ) {
      engine.fadeOutAll(FEED_SWITCH_FADE_MS);
    }
    previousRunRef.current = { access, engine, targetKey };

    const activeTarget = parseFeedTarget(JSON.parse(targetKey));
    const identity = "did" in access ? access.did : access.authMethod;
    const trendKey = `${targetKey}|${access.authMethod}|${identity}`;
    if (trendKeyRef.current !== trendKey) {
      trendRef.current.reset();
      trendKeyRef.current = trendKey;
    }
    // Guests have no feed client; asking them for a session feed is a target-fatal error.
    const sourceAccess: PostSourceAccess =
      access.authMethod === "guest"
        ? { seenPosts: access.seenPosts }
        : { feedClient: access.feedClient, seenPosts: access.seenPosts };
    const pipeline = new GardenPipeline({
      createSource: (events) => createPostSource(sourceAccess, activeTarget, events),
      // After-growth applies to the global source only (docs/DESIGN.md section 36.3).
      ...(activeTarget.kind === "global" ? { engagementClient: access.engagementClient } : {}),
      sink: engine,
      trend: trendRef.current,
      onError: (kind) => {
        setFeedError({ source: "feed", kind });
      },
      onRecovered: () => {
        setFeedError(null);
      },
      onSessionFatal: (kind) => {
        onSessionLostRef.current(kind);
      },
      onTargetFatal: (kind) => {
        setFeedError(null);
        setTargetError({ source: "target", kind });
      },
    });
    pipelineRef.current = pipeline;

    pipeline.start();
    if (pausedRef.current) pipeline.pause();

    return () => {
      pipelineRef.current = null;
      pipeline.stop();
      engine.clearPending();
      setFeedError(null);
      setTargetError(null);
    };
  }, [access, engine, targetKey]);

  useEffect(() => {
    pausedRef.current = paused;
    const pipeline = pipelineRef.current;
    if (pipeline === null) return;
    if (paused) pipeline.pause();
    else pipeline.resume();
  }, [paused]);

  return { feedError, targetError };
}
