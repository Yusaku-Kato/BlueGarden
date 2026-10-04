import { useEffect } from "react";
import type { SessionNotice } from "../hooks/useBlueskySession";

const NOTICE_MESSAGES: Readonly<Record<SessionNotice, string>> = {
  secureStorageUnavailable: "この端末にログイン情報を保存できませんでした",
};

/** How long a non-blocking notice stays visible. */
export const NOTICE_VISIBLE_MS = 8_000;

interface NoticeBannerProps {
  notice: SessionNotice;
  onDismiss: () => void;
}

/** Non-blocking information. Dismisses itself; never takes focus. */
export default function NoticeBanner({ notice, onDismiss }: NoticeBannerProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, NOTICE_VISIBLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice, onDismiss]);

  return (
    <div className="notice-banner" role="status">
      {NOTICE_MESSAGES[notice]}
    </div>
  );
}
