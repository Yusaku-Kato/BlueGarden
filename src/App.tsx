import { useCallback, useMemo, useRef, useState } from "react";
import type { FeedTarget, RuntimeSettings } from "./domain/models";
import type { RuntimeSettingsPatch } from "./domain/settings";
import type { DisplayError } from "./app/displayErrors";
import DevStats from "./components/DevStats";
import ErrorBanner from "./components/ErrorBanner";
import FeedCaption from "./components/FeedCaption";
import GardenMenu from "./components/GardenMenu";
import LoginPanel from "./components/LoginPanel";
import NoticeBanner from "./components/NoticeBanner";
import RestoringIndicator from "./components/RestoringIndicator";
import SettingsPanel from "./components/SettingsPanel";
import TerrariumCanvas from "./components/TerrariumCanvas";
import { useBlueskySession } from "./hooks/useBlueskySession";
import { useCloseToTray } from "./hooks/useCloseToTray";
import { useDisplayMode } from "./hooks/useDisplayMode";
import { useGardenFeed } from "./hooks/useGardenFeed";
import { useSavedFeeds } from "./hooks/useSavedFeeds";
import { useSettings } from "./hooks/useSettings";
import { useTerrarium } from "./hooks/useTerrarium";
import { useWindowHidden } from "./hooks/useWindowHidden";
import { resolveHandleToDid } from "./services/bluesky/feedDiscovery";
import { resolveFeedUri } from "./services/bluesky/feedTargets";

const SHOW_DEV_STATS =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has("stats");

const GUEST_TARGET: FeedTarget = { kind: "global" };

function rejectFeedInput(): Promise<string> {
  return Promise.reject(new Error("guest"));
}

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const {
    status,
    access,
    session,
    authError,
    notice,
    pendingLogin,
    loginAction,
    loginWithOAuthAction,
    cancelOAuth,
    enterAsGuest,
    logout,
    dismissNotice,
    reportSessionLost,
  } = useBlueskySession();
  const guest = status === "guest";
  const signedIn = access !== null;
  const windowHidden = useWindowHidden();
  const { settings, loaded: settingsLoaded, update, reset } = useSettings();
  const display = useDisplayMode();
  useCloseToTray(settings.window.closeToTray, settingsLoaded);
  const [settingsRequested, setSettingsRequested] = useState(false);
  const settingsOpen = settingsRequested && signedIn;
  const { engine, renderError, activeRenderer } = useTerrarium(hostRef, {
    renderer: settings.renderer,
    dimmed: !signedIn,
    paused: windowHidden,
    renderSettings: settings.render,
  });
  // Guests only see the Global Garden; the saved feed setting is left untouched.
  const feedTarget = guest ? GUEST_TARGET : settings.feed;
  const { feedError, targetError } = useGardenFeed(access, engine, feedTarget, reportSessionLost, windowHidden);
  const { savedFeeds, loading: loadingSavedFeeds } = useSavedFeeds(session, settingsOpen);

  const openSettings = useCallback((): void => {
    setSettingsRequested(true);
  }, []);
  const closeSettings = useCallback((): void => {
    setSettingsRequested(false);
  }, []);

  const resolveFeedInput = useMemo(() => {
    if (session === null) return rejectFeedInput;
    return (input: string): Promise<string> =>
      resolveFeedUri(input, (handle) => resolveHandleToDid(session.feedDirectory, handle));
  }, [session]);

  const panelSettings = useMemo<RuntimeSettings>(
    () => (guest ? { ...settings, feed: GUEST_TARGET } : settings),
    [guest, settings],
  );
  const updateFromPanel = useCallback(
    (patch: RuntimeSettingsPatch): void => {
      if (guest) {
        const withoutFeed: { -readonly [K in keyof RuntimeSettingsPatch]: RuntimeSettingsPatch[K] } = { ...patch };
        delete withoutFeed.feed; // the saved feed is not changed while browsing as a guest
        update(withoutFeed);
      } else {
        update(patch);
      }
    },
    [guest, update],
  );

  const resetSettings = useCallback((): void => {
    reset({ keepFeed: guest }); // a guest's reset must not change the saved feed
  }, [guest, reset]);

  const handleOAuthLogin = useCallback(
    (identifier: string, remember: boolean): void => {
      void loginWithOAuthAction(identifier, remember);
    },
    [loginWithOAuthAction],
  );

  // Priority: render > auth > target > feed. Auth errors are shown inside LoginPanel on the login screen.
  const bannerError: DisplayError | null = renderError ?? (signedIn ? (targetError ?? feedError) : null);
  const showUi = !display.screensaver;

  return (
    <main className={display.screensaver ? "app screensaver" : "app"}>
      <TerrariumCanvas ref={hostRef} />
      {showUi && bannerError !== null ? <ErrorBanner error={bannerError} /> : null}
      {showUi && status === "restoring" ? <RestoringIndicator /> : null}
      {showUi && signedIn ? (
        <GardenMenu
          guest={guest}
          fullscreen={display.fullscreen}
          onLogout={() => {
            setSettingsRequested(false);
            void logout();
          }}
          onOpenSettings={openSettings}
          onToggleFullscreen={display.toggleFullscreen}
          onEnterScreensaver={display.enterScreensaver}
        />
      ) : null}
      {showUi && !signedIn && status !== "restoring" ? (
        <LoginPanel
          signingIn={status === "signingIn"}
          pendingLogin={pendingLogin}
          error={authError}
          loginAction={loginAction}
          onOAuthLogin={handleOAuthLogin}
          onCancelOAuth={cancelOAuth}
          onEnterAsGuest={enterAsGuest}
        />
      ) : null}
      {showUi && settingsOpen ? (
        <SettingsPanel
          settings={panelSettings}
          onChange={updateFromPanel}
          onReset={resetSettings}
          onClose={closeSettings}
          savedFeeds={savedFeeds}
          loadingSavedFeeds={loadingSavedFeeds}
          guest={guest}
          onResolveFeedInput={resolveFeedInput}
        />
      ) : null}
      {signedIn ? <FeedCaption target={feedTarget} savedFeeds={savedFeeds} hidden={!showUi} /> : null}
      {showUi && signedIn && notice !== null ? <NoticeBanner notice={notice} onDismiss={dismissNotice} /> : null}
      {SHOW_DEV_STATS ? <DevStats engine={engine} access={access} renderer={activeRenderer} /> : null}
    </main>
  );
}
