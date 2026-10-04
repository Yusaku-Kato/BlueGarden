import type { GardenErrorKind } from "../services/bluesky/errors";

/** The single error shape shown in the UI (docs/DESIGN.md section 5.5). */
export type DisplayError =
  | { readonly source: "auth" | "feed" | "target"; readonly kind: GardenErrorKind }
  | { readonly source: "render"; readonly kind: "initFailed" | "contextLost" | "fallback2d" };

const SHARED_MESSAGES: Readonly<Record<GardenErrorKind, string>> = {
  invalidHandle: "ハンドルの形式が正しくありません (例: name.bsky.social)",
  invalidCredentials: "ハンドルまたは App Password が正しくありません",
  authFactorRequired: "通常のパスワードではなく App Password を使用してください",
  accountUnavailable: "このアカウントでは利用できません",
  unsupportedPds: "このアカウントのサーバーには現在対応していません",
  sessionExpired: "セッションが切れました。再度ログインしてください",
  network: "ネットワークに接続できません。再試行中…",
  timeout: "Bluesky からの応答がありません。再試行中…",
  rateLimited: "アクセスが集中しています。待機して再試行します",
  serverError: "Bluesky との通信でエラーが発生しました。再試行中…",
  notFound: "フィードが見つかりません",
  malformedResponse: "Bluesky からの応答を読み取れません。再試行中…",
  notImplemented: "このフィードにはまだ対応していません",
  invalidFeedTarget: "フィードのアドレスまたは検索語が正しくありません",
  authCancelled: "ログインが中断されました。もう一度お試しください",
  secureStorageUnavailable: "安全な保存領域を使用できないため、ログイン情報は記憶されません",
  unknown: "予期しないエラーが発生しました。再試行中…",
};

const LOGIN_RATE_LIMITED = "しばらく待ってから再度お試しください";
const LOGIN_UNKNOWN = "予期しないエラーが発生しました。もう一度お試しください";

const RENDER_MESSAGES = {
  initFailed: "描画を初期化できませんでした (GPU / WebGL を確認してください)",
  contextLost: "描画が中断されました。アプリを再起動してください",
  fallback2d: "3D 表示を初期化できなかったため 2D で表示しています",
} as const;

const TARGET_MESSAGES: Readonly<Partial<Record<GardenErrorKind, string>>> = {
  notFound: "フィードが見つかりません。設定から別のフィードを選んでください",
  invalidFeedTarget: "フィードのアドレスまたは検索語が正しくありません。設定から別のフィードを選んでください",
  notImplemented: "このフィードにはまだ対応していません。設定から別のフィードを選んでください",
};
const TARGET_FALLBACK = "このフィードを表示できません。設定から別のフィードを選んでください";

/** Short, actionable Japanese message. Never contains secrets or post text. */
export function messageFor(error: DisplayError): string {
  if (error.source === "render") return RENDER_MESSAGES[error.kind];
  if (error.source === "target") return TARGET_MESSAGES[error.kind] ?? TARGET_FALLBACK;
  if (error.source === "auth") {
    if (error.kind === "rateLimited") return LOGIN_RATE_LIMITED;
    if (error.kind === "unknown") return LOGIN_UNKNOWN;
  }
  return SHARED_MESSAGES[error.kind];
}
