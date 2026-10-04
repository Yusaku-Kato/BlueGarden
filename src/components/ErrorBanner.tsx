import { messageFor, type DisplayError } from "../app/displayErrors";

interface ErrorBannerProps {
  error: DisplayError;
}

/** Render and session errors interrupt the garden, so they are announced assertively. */
export default function ErrorBanner({ error }: ErrorBannerProps) {
  const urgent = error.source !== "feed" && error.kind !== "fallback2d";
  return (
    <div className="error-banner" role={urgent ? "alert" : "status"}>
      {messageFor(error)}
    </div>
  );
}
