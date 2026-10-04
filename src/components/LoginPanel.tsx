import { useState, type ChangeEvent } from "react";
import { useFormStatus } from "react-dom";
import { messageFor, type DisplayError } from "../app/displayErrors";
import { looksLikeAppPassword, type PendingLogin } from "../hooks/useBlueskySession";

export interface LoginPanelProps {
  signingIn: boolean;
  /** Which sign-in is running while `signingIn` is true. */
  pendingLogin: PendingLogin | null;
  error: DisplayError | null;
  loginAction: (formData: FormData) => Promise<void>;
  onOAuthLogin: (identifier: string, remember: boolean) => void;
  onCancelOAuth: () => void;
  onEnterAsGuest: () => void;
}

export default function LoginPanel({
  signingIn,
  pendingLogin,
  error,
  loginAction,
  onOAuthLogin,
  onCancelOAuth,
  onEnterAsGuest,
}: LoginPanelProps) {
  // Only a boolean is kept; the password value itself never enters React state.
  const [passwordLooksWrong, setPasswordLooksWrong] = useState(false);

  return (
    <div className="login-overlay">
      <form
        className="login-panel"
        action={loginAction}
        onReset={() => {
          setPasswordLooksWrong(false);
        }}
        aria-labelledby="login-title"
      >
        <LoginFields
          signingIn={signingIn}
          pendingLogin={pendingLogin}
          error={error}
          passwordLooksWrong={passwordLooksWrong}
          onPasswordShapeChange={setPasswordLooksWrong}
          onOAuthLogin={onOAuthLogin}
          onCancelOAuth={onCancelOAuth}
          onEnterAsGuest={onEnterAsGuest}
        />
      </form>
    </div>
  );
}

interface LoginFieldsProps {
  signingIn: boolean;
  pendingLogin: PendingLogin | null;
  error: DisplayError | null;
  passwordLooksWrong: boolean;
  onPasswordShapeChange: (looksWrong: boolean) => void;
  onOAuthLogin: (identifier: string, remember: boolean) => void;
  onCancelOAuth: () => void;
  onEnterAsGuest: () => void;
}

/**
 * Rendered inside the form so useFormStatus() can report the pending action: state updates made
 * inside a React 19 form action are not committed until the action settles.
 */
function LoginFields({
  signingIn,
  pendingLogin,
  error,
  passwordLooksWrong,
  onPasswordShapeChange,
  onOAuthLogin,
  onCancelOAuth,
  onEnterAsGuest,
}: LoginFieldsProps) {
  const { pending } = useFormStatus();
  const busy = pending || signingIn;
  const waitingForBrowser = signingIn && pendingLogin === "oauth";
  // Not secret: only the checkbox state is kept.
  const [remember, setRemember] = useState(false);
  // The handle is not secret and is kept across failed attempts (React resets uncontrolled fields
  // after an action). The password stays uncontrolled and never enters React state.
  const [identifier, setIdentifier] = useState("");

  const handlePasswordChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const typed = event.currentTarget.value;
    onPasswordShapeChange(typed.length > 0 && !looksLikeAppPassword(typed));
  };

  return (
    <>
      <h1 id="login-title" className="login-title">
        BlueGarden
      </h1>
      <p className="login-tagline">SNSの流れを、静かな庭として眺める。</p>

      <label className="login-field">
        <span className="visually-hidden">Bluesky ハンドル (OAuth ではメールアドレスも可)</span>
        <input
          type="text"
          name="identifier"
          placeholder="handle.bsky.social"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={identifier}
          onChange={(event) => {
            setIdentifier(event.currentTarget.value);
          }}
          readOnly={busy}
          aria-label="Bluesky ハンドル (OAuth ではメールアドレスも可)"
        />
      </label>

      <label className="login-field">
        <span className="visually-hidden">App Password</span>
        <input
          type="password"
          name="appPassword"
          placeholder="App Password"
          autoComplete="off"
          spellCheck={false}
          readOnly={busy}
          onChange={handlePasswordChange}
          aria-label="App Password"
        />
      </label>

      {passwordLooksWrong ? (
        <p className="login-hint" role="note">
          通常のパスワードではなく App Password を使用してください
        </p>
      ) : null}

      {error !== null && !busy ? (
        <p className="login-error" role="alert">
          {messageFor(error)}
        </p>
      ) : null}

      <label className="login-remember">
        <input
          type="checkbox"
          name="remember"
          checked={remember}
          disabled={busy}
          onChange={(event) => {
            setRemember(event.currentTarget.checked);
          }}
        />
        <span>この端末で記憶する</span>
      </label>

      <button type="submit" className="login-submit" disabled={busy}>
        {busy && !waitingForBrowser ? "Entering…" : "Enter Garden"}
      </button>

      {waitingForBrowser ? (
        <div className="login-waiting" role="status">
          <span>ブラウザで認証してください…</span>
          <button type="button" className="login-secondary" onClick={onCancelOAuth}>
            キャンセル
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="login-secondary"
          disabled={busy}
          onClick={() => {
            onOAuthLogin(identifier, remember);
          }}
        >
          OAuth でログイン (ブラウザ)
        </button>
      )}

      <div className="login-divider" role="separator" />

      <button type="button" className="login-secondary" disabled={busy} onClick={onEnterAsGuest}>
        ログインせずに Bluesky 全体を眺める (Global Garden)
      </button>

      <p className="login-note">
        App Password は Bluesky の 設定 → プライバシーとセキュリティ → アプリパスワード で作成できます。OAuth ではハンドル、メールアドレス、または空欄のまま押してください。ブラウザの Bluesky 画面でサインインします
        (パスワードはアプリに渡りません)
      </p>
    </>
  );
}
