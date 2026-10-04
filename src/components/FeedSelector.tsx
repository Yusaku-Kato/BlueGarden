import { useId, useState } from "react";
import { FEED } from "../config/gardenConfig";
import type { FeedTarget } from "../domain/models";

export interface SavedFeed {
  readonly uri: string;
  readonly displayName: string;
}

export interface FeedSelectorProps {
  value: FeedTarget;
  savedFeeds: readonly SavedFeed[];
  loadingSavedFeeds: boolean;
  guest: boolean;
  onChange: (target: FeedTarget) => void;
  onResolveFeedInput: (input: string) => Promise<string>;
}

type Mode = "timeline" | "saved" | "discover" | "url" | "keyword" | "global";

const GUEST_HINT = "ログインすると選べます";
const URL_ERROR = "フィードを見つけられませんでした。URL か at:// の URI を確認してください。";

function modeOf(value: FeedTarget, savedFeeds: readonly SavedFeed[]): Mode {
  switch (value.kind) {
    case "timeline":
      return "timeline";
    case "global":
      return "global";
    case "keyword":
      return "keyword";
    case "custom":
      if (value.feedUri === FEED.DISCOVER_FEED_URI) return "discover";
      return savedFeeds.some((feed) => feed.uri === value.feedUri) ? "saved" : "url";
  }
}

export default function FeedSelector({
  value,
  savedFeeds,
  loadingSavedFeeds,
  guest,
  onChange,
  onResolveFeedInput,
}: FeedSelectorProps) {
  const groupName = useId();
  const [draftMode, setDraftMode] = useState<Mode | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [keywordInput, setKeywordInput] = useState(value.kind === "keyword" ? value.query : "");
  const [keywordError, setKeywordError] = useState<string | null>(null);

  const mode: Mode = guest ? "global" : (draftMode ?? modeOf(value, savedFeeds));

  const choose = (next: Mode, target?: FeedTarget): void => {
    if (target === undefined) {
      setDraftMode(next);
      return;
    }
    setDraftMode(null);
    onChange(target);
  };

  const applyUrl = (): void => {
    const input = urlInput.trim();
    if (input === "") {
      setUrlError(URL_ERROR);
      return;
    }
    setResolving(true);
    setUrlError(null);
    onResolveFeedInput(input).then(
      (feedUri) => {
        setResolving(false);
        setDraftMode(null);
        onChange({ kind: "custom", feedUri });
      },
      () => {
        setResolving(false);
        setUrlError(URL_ERROR);
      },
    );
  };

  const applyKeyword = (): void => {
    const query = keywordInput.trim();
    if (query === "") {
      setKeywordError("キーワードを入力してください。");
      return;
    }
    if (query.length > FEED.MAX_QUERY_LENGTH) {
      setKeywordError(`キーワードは ${String(FEED.MAX_QUERY_LENGTH)} 文字以内にしてください。`);
      return;
    }
    setKeywordError(null);
    setDraftMode(null);
    onChange({ kind: "keyword", query });
  };

  const radio = (id: Mode, label: string, onSelect: () => void, restricted = true) => (
    <label className="feed-option">
      <input
        type="radio"
        name={groupName}
        checked={mode === id}
        disabled={guest && restricted}
        onChange={onSelect}
      />
      <span>{label}</span>
    </label>
  );

  const selectedSavedUri = value.kind === "custom" ? value.feedUri : "";

  return (
    <fieldset className="settings-group feed-selector">
      <legend>フィード</legend>
      {guest ? <p className="settings-hint">{GUEST_HINT}</p> : null}

      {radio("timeline", "タイムライン", () => {
        choose("timeline", { kind: "timeline" });
      })}

      {radio("saved", "保存したフィード", () => {
        choose("saved");
      })}
      {mode === "saved" ? (
        <div className="feed-detail">
          {loadingSavedFeeds ? (
            <p className="settings-hint">読み込み中…</p>
          ) : savedFeeds.length === 0 ? (
            <p className="settings-hint">保存したフィードがありません。</p>
          ) : (
            <select
              aria-label="保存したフィード"
              value={savedFeeds.some((feed) => feed.uri === selectedSavedUri) ? selectedSavedUri : ""}
              onChange={(event) => {
                const feedUri = event.target.value;
                if (feedUri !== "") choose("saved", { kind: "custom", feedUri });
              }}
            >
              <option value="">選択してください</option>
              {savedFeeds.map((feed) => (
                <option key={feed.uri} value={feed.uri}>
                  {feed.displayName}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : null}

      {radio("discover", "Discover", () => {
        choose("discover", { kind: "custom", feedUri: FEED.DISCOVER_FEED_URI });
      })}

      {radio("url", "フィード URL/URI を入力", () => {
        choose("url");
      })}
      {mode === "url" ? (
        <div className="feed-detail">
          <div className="feed-input-row">
            <input
              type="text"
              aria-label="フィードの URL または URI"
              placeholder="https://bsky.app/profile/…/feed/… または at://…"
              value={urlInput}
              disabled={resolving}
              onChange={(event) => {
                setUrlInput(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyUrl();
              }}
            />
            <button type="button" disabled={resolving} onClick={applyUrl}>
              {resolving ? "確認中…" : "適用"}
            </button>
          </div>
          {urlError !== null ? (
            <p className="settings-error" role="alert">
              {urlError}
            </p>
          ) : null}
        </div>
      ) : null}

      {radio("keyword", "キーワード", () => {
        choose("keyword");
      })}
      {mode === "keyword" ? (
        <div className="feed-detail">
          <div className="feed-input-row">
            <input
              type="text"
              aria-label="検索キーワード"
              maxLength={FEED.MAX_QUERY_LENGTH}
              value={keywordInput}
              onChange={(event) => {
                setKeywordInput(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") applyKeyword();
              }}
            />
            <button type="button" onClick={applyKeyword}>
              適用
            </button>
          </div>
          {keywordError !== null ? (
            <p className="settings-error" role="alert">
              {keywordError}
            </p>
          ) : null}
        </div>
      ) : null}

      {radio(
        "global",
        "Global Garden (Bluesky 全体)",
        () => {
          choose("global", { kind: "global" });
        },
        false,
      )}
    </fieldset>
  );
}
