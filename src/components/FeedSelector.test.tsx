// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FEED } from "../config/gardenConfig";
import type { FeedTarget } from "../domain/models";
import FeedSelector, { type FeedSelectorProps } from "./FeedSelector";

const SAVED_URI = "at://did:plc:a/app.bsky.feed.generator/one";

function setup(overrides: Partial<FeedSelectorProps> = {}) {
  const props: FeedSelectorProps = {
    value: { kind: "timeline" },
    savedFeeds: [{ uri: SAVED_URI, displayName: "Alpha" }],
    loadingSavedFeeds: false,
    guest: false,
    onChange: vi.fn<(target: FeedTarget) => void>(),
    onResolveFeedInput: vi.fn(() => Promise.resolve("at://did:plc:z/app.bsky.feed.generator/resolved")),
    ...overrides,
  };
  render(<FeedSelector {...props} />);
  return props;
}

function radio(name: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("radio", { name });
}

describe("FeedSelector", () => {
  afterEach(cleanup);

  it("selects discover and global immediately", () => {
    const props = setup();
    fireEvent.click(radio("Discover"));
    expect(props.onChange).toHaveBeenLastCalledWith({ kind: "custom", feedUri: FEED.DISCOVER_FEED_URI });
    fireEvent.click(radio("Global Garden (Bluesky 全体)"));
    expect(props.onChange).toHaveBeenLastCalledWith({ kind: "global" });
  });

  it("lists saved feeds and emits a custom target", () => {
    const props = setup();
    fireEvent.click(radio("保存したフィード"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: SAVED_URI } });
    expect(props.onChange).toHaveBeenCalledWith({ kind: "custom", feedUri: SAVED_URI });
  });

  it("only allows global for guests", () => {
    const props = setup({ guest: true });
    expect(screen.getByText("ログインすると選べます")).toBeTruthy();
    expect(radio("タイムライン").disabled).toBe(true);
    expect(radio("キーワード").disabled).toBe(true);
    expect(radio("Discover").disabled).toBe(true);
    const global = radio("Global Garden (Bluesky 全体)");
    expect(global.disabled).toBe(false);
    expect(global.checked).toBe(true);
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("validates and trims keywords", () => {
    const props = setup();
    fireEvent.click(radio("キーワード"));
    const input = screen.getByLabelText("検索キーワード");
    expect(input.getAttribute("maxlength")).toBe(String(FEED.MAX_QUERY_LENGTH));
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(props.onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  bluesky  " } });
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(props.onChange).toHaveBeenCalledWith({ kind: "keyword", query: "bluesky" });
  });

  it("resolves a pasted feed URL", async () => {
    const props = setup();
    fireEvent.click(radio("フィード URL/URI を入力"));
    fireEvent.change(screen.getByLabelText("フィードの URL または URI"), {
      target: { value: " https://bsky.app/profile/x/feed/y " },
    });
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    await waitFor(() => {
      expect(props.onChange).toHaveBeenCalledWith({
        kind: "custom",
        feedUri: "at://did:plc:z/app.bsky.feed.generator/resolved",
      });
    });
    expect(props.onResolveFeedInput).toHaveBeenCalledWith("https://bsky.app/profile/x/feed/y");
  });

  it("shows an inline error when resolving fails, without leaking the cause", async () => {
    const props = setup({ onResolveFeedInput: vi.fn(() => Promise.reject(new Error("secret detail"))) });
    fireEvent.click(radio("フィード URL/URI を入力"));
    fireEvent.change(screen.getByLabelText("フィードの URL または URI"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("secret detail");
    expect(props.onChange).not.toHaveBeenCalled();
  });
});
