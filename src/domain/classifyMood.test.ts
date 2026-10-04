import { describe, expect, it } from "vitest";
import { classifyMood } from "./classifyMood";

describe("classifyMood", () => {
  it("classifies English positive and negative keywords", () => {
    expect(classifyMood("I am so happy today")).toBe("positive");
    expect(classifyMood("this is awesome")).toBe("positive");
    expect(classifyMood("I feel sad")).toBe("negative");
    expect(classifyMood("so tired and angry")).toBe("negative");
  });

  it("classifies Japanese keywords by substring", () => {
    expect(classifyMood("今日は最高の一日")).toBe("positive");
    expect(classifyMood("嬉しい")).toBe("positive");
    expect(classifyMood("笑")).toBe("positive");
    expect(classifyMood("もう疲れた")).toBe("negative");
    expect(classifyMood("怒")).toBe("negative");
  });

  it("is case-insensitive and NFKC-normalizing", () => {
    expect(classifyMood("HAPPY")).toBe("positive");
    expect(classifyMood("ＨＡＰＰＹ")).toBe("positive");
  });

  it("matches word prefixes only", () => {
    expect(classifyMood("he hates it")).toBe("negative");
    expect(classifyMood("I loved it")).toBe("positive");
    expect(classifyMood("whatever")).toBe("neutral");
    expect(classifyMood("unhappy")).toBe("neutral");
  });

  it("returns neutral for ties and empty text", () => {
    expect(classifyMood("happy but sad")).toBe("neutral");
    expect(classifyMood("")).toBe("neutral");
    expect(classifyMood("nothing special")).toBe("neutral");
  });

  it("handles mixed language by counting occurrences", () => {
    expect(classifyMood("happy 最高 sad")).toBe("positive");
    expect(classifyMood("sad 最悪 love")).toBe("negative");
    expect(classifyMood("sad 最高")).toBe("neutral");
    expect(classifyMood("sad 最悪 tired love")).toBe("negative");
  });

  it("classifies expanded Japanese vocabulary", () => {
    for (const text of ["ありがとう", "おめでとう！", "かわいい猫", "素敵な景色", "美味しかった", "よかった", "感動した"]) {
      expect(classifyMood(text)).toBe("positive");
    }
    for (const text of ["しんどい", "寂しい夜", "ムカつく", "不安だ", "もう無理", "憂鬱", "絶望した"]) {
      expect(classifyMood(text)).toBe("negative");
    }
    expect(classifyMood("愛知県に行く")).toBe("neutral");
    expect(classifyMood("草むしり")).toBe("neutral");
  });

  it("classifies expanded English vocabulary", () => {
    for (const text of ["Thanks a lot", "Congratulations!", "so excited", "what a cute dog", "lol", "yay", "loving it"]) {
      expect(classifyMood(text)).toBe("positive");
    }
    for (const text of ["I am exhausted", "this is awful", "so lonely", "I hate mondays", "I'm crying", "feeling anxious", "sick of it"]) {
      expect(classifyMood(text)).toBe("negative");
    }
  });

  it("classifies Portuguese and Spanish keywords", () => {
    expect(classifyMood("Obrigada!")).toBe("positive");
    expect(classifyMood("parabéns")).toBe("positive");
    expect(classifyMood("gracias, genial")).toBe("positive");
    expect(classifyMood("estou triste")).toBe("negative");
    expect(classifyMood("odeio isso")).toBe("negative");
    expect(classifyMood("estoy cansada")).toBe("negative");
  });

  it("classifies emoji, including with the variation selector", () => {
    expect(classifyMood("😊")).toBe("positive");
    expect(classifyMood("❤️")).toBe("positive");
    expect(classifyMood("❤")).toBe("positive");
    expect(classifyMood("👍🏽")).toBe("positive");
    expect(classifyMood("😭")).toBe("negative");
    expect(classifyMood("💔")).toBe("negative");
    expect(classifyMood("🥺")).toBe("neutral");
  });

  it("avoids false positives from stems and substrings", () => {
    for (const text of ["whatever", "fund raising", "funeral", "chateau", "cryptocurrency", "gladiator", "amount", "saddle", "bestow", "www.example.com", "happen"]) {
      expect(classifyMood(text)).toBe("neutral");
    }
    expect(classifyMood("fun")).toBe("positive");
    expect(classifyMood("sad")).toBe("negative");
  });

  it("treats regex metacharacters in text as plain input", () => {
    expect(classifyMood("(.*+?^${}|[]) happy")).toBe("positive");
    expect(classifyMood("\\b\\")).toBe("neutral");
  });
});
