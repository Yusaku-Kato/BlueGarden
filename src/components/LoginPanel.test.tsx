// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPanel, { type LoginPanelProps } from "./LoginPanel";

const HANDLE_LABEL = "Bluesky ハンドル (OAuth ではメールアドレスも可)";

function renderPanel(overrides: Partial<LoginPanelProps> = {}) {
  const props: LoginPanelProps = {
    signingIn: false,
    pendingLogin: null,
    error: null,
    loginAction: vi.fn(() => Promise.resolve()),
    onOAuthLogin: vi.fn(),
    onCancelOAuth: vi.fn(),
    onEnterAsGuest: vi.fn(),
    ...overrides,
  };
  render(<LoginPanel {...props} />);
  return props;
}

describe("LoginPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the App Password, OAuth and guest entry points in Japanese", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Enter Garden" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "OAuth でログイン (ブラウザ)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ログインせずに Bluesky 全体を眺める (Global Garden)" })).toBeTruthy();
    const remember = screen.getByRole("checkbox", { name: "この端末で記憶する" });
    expect((remember as HTMLInputElement).checked).toBe(false);
  });

  it("keeps the password input a non-autofilled password field", () => {
    renderPanel();
    const password = screen.getByLabelText("App Password");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("off");
  });

  it("starts OAuth with the handle field and the remember checkbox only", () => {
    const props = renderPanel();
    fireEvent.change(screen.getByLabelText(HANDLE_LABEL), { target: { value: "alice.bsky.social" } });
    fireEvent.click(screen.getByRole("button", { name: "OAuth でログイン (ブラウザ)" }));
    expect(props.onOAuthLogin).toHaveBeenLastCalledWith("alice.bsky.social", false);

    fireEvent.click(screen.getByRole("checkbox", { name: "この端末で記憶する" }));
    fireEvent.click(screen.getByRole("button", { name: "OAuth でログイン (ブラウザ)" }));
    expect(props.onOAuthLogin).toHaveBeenLastCalledWith("alice.bsky.social", true);
  });

  it("lets OAuth start with a blank or email identifier and explains it", () => {
    const props = renderPanel();
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "OAuth でログイン (ブラウザ)" });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(props.onOAuthLogin).toHaveBeenLastCalledWith("", false);
    fireEvent.change(screen.getByLabelText(HANDLE_LABEL), { target: { value: "me@example.com" } });
    fireEvent.click(button);
    expect(props.onOAuthLogin).toHaveBeenLastCalledWith("me@example.com", false);
    expect(screen.getByLabelText(HANDLE_LABEL).getAttribute("placeholder")).toBe("handle.bsky.social");
    expect(document.body.textContent.replace(/\s+/g, "")).toContain(
      "メールアドレス、または空欄のまま押してください",
    );
  });

  it("enters the Global Garden as a guest", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "ログインせずに Bluesky 全体を眺める (Global Garden)" }));
    expect(props.onEnterAsGuest).toHaveBeenCalledTimes(1);
    expect(props.onOAuthLogin).not.toHaveBeenCalled();
  });

  it("shows a waiting state with a cancel button during OAuth and disables the other entries", () => {
    const props = renderPanel({ signingIn: true, pendingLogin: "oauth" });
    expect(screen.getByRole("status").textContent).toContain("ブラウザで認証してください");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Enter Garden" }).disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "ログインせずに Bluesky 全体を眺める (Global Garden)",
      }).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "OAuth でログイン (ブラウザ)" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(props.onCancelOAuth).toHaveBeenCalledTimes(1);
  });

  it("disables every entry while an App Password login is running", () => {
    renderPanel({ signingIn: true, pendingLogin: "appPassword" });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Entering…" }).disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "OAuth でログイン (ブラウザ)" }).disabled,
    ).toBe(true);
  });

  it("shows the error message", () => {
    renderPanel({ error: { source: "auth", kind: "invalidCredentials" } });
    expect(screen.getByRole("alert").textContent).toContain("App Password");
  });
});
