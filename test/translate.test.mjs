/**
 * dsh-rss-reader — translation tests.
 *
 * The model call itself is exercised through a fake `llm` service, so the whole
 * path (prompt build → streamed chunks → JSON extraction → stored translation)
 * runs without network access. What matters here:
 *
 * - Markdown, URLs and code must survive the round trip;
 * - a model that ignores the JSON instruction must still produce something
 *   usable rather than a hard failure;
 * - a failure must be reported, never thrown, so the reader keeps working.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TARGET,
  MAX_TRANSLATE_MAX_TOKENS,
  TARGET_LANGUAGES,
  alignSegments,
  buildTranslatePrompt,
  extractJsonObject,
  extractSegmentResult,
  isStructuralBlock,
  maxTokensFor,
  normalizeTarget,
  normalizeTranslation,
  splitMarkdownBlocks,
  translateItem
} from "../lib/translate.js";

/**
 * Build a fake LLM service that streams the given text back in chunks.
 *
 * Mimics the harness stream protocol, which is what `BlockAssembler` consumes:
 * `block-start` opens a block, one or more `text-delta` chunks carry its text,
 * and `block-end` closes it. Getting this shape wrong is not cosmetic — the
 * assembler asserts on an unknown chunk type.
 *
 * @param {string | Error} text - text to stream, or an error to raise.
 * @param {object} [options] - `{capture}` receives the stream options.
 */
function fakeLlm(text, options = {}) {
  return {
    stream(streamOptions) {
      options.capture?.(streamOptions);
      return (async function* generate() {
        if (text instanceof Error) throw text;
        const body = String(text);
        yield { type: "block-start", index: 0, blockType: "text" };
        // Split mid-token the way a real model does, so assembly is exercised.
        for (const piece of body.match(/[\s\S]{1,17}/g) ?? []) {
          yield { type: "text-delta", index: 0, text: piece };
        }
        yield { type: "block-end", index: 0, block: { type: "text", text: body } };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    }
  };
}

const ITEM = {
  title: "Hello World",
  markdown: "# Heading\n\nSee [the docs](https://x.test/docs) and `code`.\n\n![pic](https://x.test/a.png)",
  summary: "A summary",
  target: "zh-CN"
};

// ── Target normalization ────────────────────────────────────────────────────

test("normalizeTarget resolves presets, bare codes, and free text", () => {
  assert.equal(normalizeTarget("zh-CN"), TARGET_LANGUAGES["zh-CN"]);
  assert.equal(normalizeTarget("en"), TARGET_LANGUAGES.en);
  // A code that is not a preset is passed through as a name.
  assert.equal(normalizeTarget("uk"), "uk");
  // Free text lets a user ask for anything.
  assert.equal(normalizeTarget("Brazilian Portuguese"), "Brazilian Portuguese");
  // Missing or blank falls back to the default.
  assert.equal(normalizeTarget(""), TARGET_LANGUAGES[DEFAULT_TARGET]);
  assert.equal(normalizeTarget(undefined), TARGET_LANGUAGES[DEFAULT_TARGET]);
  assert.equal(normalizeTarget(42), TARGET_LANGUAGES[DEFAULT_TARGET]);
});

// ── Prompt ──────────────────────────────────────────────────────────────────

test("the prompt names the target language and the JSON contract", () => {
  const prompt = buildTranslatePrompt({ ...ITEM, target: "ja" });
  assert.match(prompt, /Japanese/);
  assert.match(prompt, /"title"/);
  // A multi-block body is sent as numbered segments and answered per segment:
  // that alignment is what the side-by-side view is built on. Match the
  // contract itself, not the rules prose that also says "segments".
  assert.match(prompt, /"segments":\[\{"index":1/);
  assert.match(prompt, /Include every index from 1 to/);
  // The rules that protect structure must be present.
  assert.match(prompt, /Preserve ALL Markdown syntax/);
  assert.match(prompt, /Do NOT translate or alter URLs/);

  // A single block still goes through the segment contract — the alignment is
  // always on, so there is one shape for the caller to parse. What changes is
  // an image-only or code-only body, which has nothing to translate.
  const single = buildTranslatePrompt({ ...ITEM, markdown: "Just one paragraph." });
  assert.match(single, /"segments":\[\{"index":1/);
  // A lone image has no prose: asking for a translation of it would only
  // invite the model to invent one, so the whole-body contract is used.
  const imageOnly = buildTranslatePrompt({ ...ITEM, markdown: "![pic](https://x.test/a.png)" });
  assert.match(imageOnly, /"markdown":"<translated body/);
  assert.doesNotMatch(imageOnly, /"segments":\[/);
});

test("the prompt carries the title and body, and skips a summary that repeats the body", () => {
  const prompt = buildTranslatePrompt(ITEM);
  assert.match(prompt, /Hello World/);
  assert.match(prompt, /the docs/);
  // ITEM.summary is a distinct string, so it is included.
  assert.match(prompt, /A summary/);

  // A summary identical to the body would only double the prompt.
  const redundant = buildTranslatePrompt({ ...ITEM, summary: ITEM.markdown });
  assert.equal(
    redundant.match(/the docs/g)?.length,
    1,
    "a summary identical to the body must not be sent twice"
  );
  assert.ok(!redundant.includes("Article summary"), "the redundant summary section should be omitted");
});

// ── JSON extraction ─────────────────────────────────────────────────────────

test("extractJsonObject reads the first balanced object", () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('Here you go:\n{"a":{"b":2}}\nDone.'), { a: { b: 2 } });
  // A brace inside a string must not close the object early.
  assert.deepEqual(extractJsonObject('{"a":"} not the end"}'), { a: "} not the end" });
  // An escaped quote inside a string must not end it.
  assert.deepEqual(extractJsonObject('{"a":"say \\"hi\\""}'), { a: 'say "hi"' });
});

test("extractJsonObject rejects unusable input", () => {
  assert.equal(extractJsonObject("no object here"), null);
  assert.equal(extractJsonObject('{"unterminated":'), null);
  assert.equal(extractJsonObject("[1,2,3]"), null, "an array is not the requested shape");
  assert.equal(extractJsonObject(null), null);
});

// ── Response normalization ──────────────────────────────────────────────────

test("normalizeTranslation reads the JSON form", () => {
  const result = normalizeTranslation('{"title":"标题","markdown":"# 标题\\n\\n正文"}');
  assert.equal(result.title, "标题");
  assert.match(result.markdown, /正文/);
});

test("normalizeTranslation accepts the body under an alternate key", () => {
  const result = normalizeTranslation('{"title":"T","body":"B"}');
  assert.equal(result.markdown, "B");
});

test("normalizeTranslation falls back to the raw text when JSON is absent", () => {
  // A model that ignores the instruction still yields a usable translation.
  const result = normalizeTranslation("Just the translated body", { title: "Original" });
  assert.equal(result.markdown, "Just the translated body");
  assert.equal(result.title, "Original", "the original title is kept rather than invented");
});

test("normalizeTranslation strips a stray code fence in the fallback path", () => {
  const result = normalizeTranslation("```markdown\n# 标题\n```", { title: "T" });
  assert.equal(result.markdown, "# 标题");
});

test("normalizeTranslation rejects empty output", () => {
  assert.equal(normalizeTranslation(""), null);
  assert.equal(normalizeTranslation("   "), null);
  assert.equal(normalizeTranslation(null), null);
  assert.equal(normalizeTranslation('{"title":"","markdown":""}'), null);
});

// ── Segment alignment ───────────────────────────────────────────────────────

test("splitMarkdownBlocks cuts on blank lines and keeps code intact", () => {
  // A blank line inside a fenced block is part of the sample, not a new block;
  // splitting there would shift every later segment by one.
  const body = [
    "First paragraph.",
    "",
    "```js",
    "const a = 1;",
    "",
    "const b = 2;",
    "```",
    "",
    "Last paragraph."
  ].join("\n");
  const blocks = splitMarkdownBlocks(body);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0], "First paragraph.");
  assert.match(blocks[1], /^```js/);
  assert.match(blocks[1], /const b = 2;/);
  assert.equal(blocks[2], "Last paragraph.");
  assert.deepEqual(splitMarkdownBlocks("   "), []);
});

test("isStructuralBlock spots blocks with nothing to translate", () => {
  assert.equal(isStructuralBlock("![pic](https://x.test/a.png)"), true);
  assert.equal(isStructuralBlock("```\ncode\n```"), true);
  assert.equal(isStructuralBlock("![a](https://x.test/a.png) ![b](https://x.test/b.png)"), true);
  assert.equal(isStructuralBlock("Look ![a](https://x.test/a.png) here"), false);
  assert.equal(isStructuralBlock("A sentence."), false);
});

test("alignSegments pairs only a complete, ordered answer", () => {
  const blocks = ["One.", "Two.", "Three."];
  const pairs = alignSegments(blocks, [
    { index: 1, text: "一。" },
    { index: 2, text: "二。" },
    { index: 3, text: "三。" }
  ]);
  assert.deepEqual(pairs.map((p) => p.translated), ["一。", "二。", "三。"]);
  assert.deepEqual(pairs.map((p) => p.source), blocks);

  // A structural block answered with an empty string still holds its place.
  assert.deepEqual(
    alignSegments(["Prose.", "![p](https://x.test/a.png)"], [{ index: 1, text: "散文。" }, { index: 2, text: "" }])
      .map((p) => p.translated),
    ["散文。", ""]
  );

  // Anything less than a complete answer is refused: pairing by position from a
  // short answer would print one paragraph's translation under another, which is
  // worse than not offering the view at all.
  assert.deepEqual(alignSegments(blocks, [{ index: 1, text: "一。" }]), [], "too few entries");
  assert.deepEqual(alignSegments(blocks, [
    { index: 1, text: "一。" }, { index: 2, text: "二。" }, { index: 3, text: "三。" }, { index: 4, text: "四。" }
  ]), [], "too many entries");
  assert.deepEqual(alignSegments(blocks, [
    { index: 1, text: "一。" }, { index: 1, text: "又一次。" }, { index: 3, text: "三。" }
  ]), [], "a duplicated index means the model lost track of the numbering");
  // Pairing follows the declared index, not array position, so an answer that
  // arrives out of order still lands on the right paragraphs.
  assert.deepEqual(alignSegments(blocks, [
    { index: 3, text: "三。" }, { index: 1, text: "一。" }, { index: 2, text: "二。" }
  ]).map((p) => p.translated), ["一。", "二。", "三。"], "order in the array does not matter");
  assert.deepEqual(alignSegments(blocks, [
    { index: 1, text: "" }, { index: 2, text: "" }, { index: 3, text: "" }
  ]), [], "an answer that translated nothing");
  assert.deepEqual(alignSegments([], []), []);
});

test("extractSegmentResult reads the contract and the shapes models fall back to", () => {
  const contract = extractSegmentResult('{"title":"T","segments":[{"index":1,"text":"a"},{"index":2,"text":"b"}]}');
  assert.equal(contract.title, "T");
  assert.deepEqual(contract.items, [{ index: 1, text: "a" }, { index: 2, text: "b" }]);

  // A bare array: position is the only index available.
  assert.deepEqual(extractSegmentResult('["a","b"]').items, [{ index: 1, text: "a" }, { index: 2, text: "b" }]);
  // A fenced or prose-wrapped answer still parses.
  assert.equal(extractSegmentResult('Sure!\n```json\n{"segments":[{"index":1,"text":"x"}]}\n```').items.length, 1);
  // An alternate wrapper key.
  assert.equal(extractSegmentResult('{"translations":[{"index":1,"text":"x"}]}').items.length, 1);
  assert.equal(extractSegmentResult('{"title":"only"}'), null);
  assert.equal(extractSegmentResult("no json here"), null);
});

// ── The model call ──────────────────────────────────────────────────────────

test("translateItem returns a normalized translation on success", async () => {
  const llm = fakeLlm('{"title":"你好世界","markdown":"# 标题\\n\\n见 [文档](https://x.test/docs) 与 `code`。"}');
  const result = await translateItem({ llm, provider: "p", model: "m" }, ITEM);
  assert.equal(result.status, "ok");
  assert.equal(result.title, "你好世界");
  assert.equal(result.target, "zh-CN");
  assert.match(result.language, /Chinese/);
  assert.equal(result.model, "p/m");
  assert.match(result.at, /^\d{4}-/);
  // Structure and URLs must have survived.
  assert.match(result.markdown, /\[文档\]\(https:\/\/x\.test\/docs\)/);
  assert.match(result.markdown, /`code`/);
});

test("translateItem sends the configured route and a bounded token budget", async () => {
  let captured;
  const llm = fakeLlm('{"title":"t","markdown":"m"}', { capture: (options) => { captured = options; } });
  await translateItem({ llm, provider: "prov", model: "mod" }, { ...ITEM, maxTokens: 1234 });
  assert.equal(captured.provider, "prov");
  assert.equal(captured.model, "mod");
  // The configured figure is a floor, and this body is short enough that the
  // floor is what gets sent — a longer body is what raises it.
  assert.equal(captured.maxTokens, maxTokensFor(ITEM.markdown.length, 1234));
  assert.equal(captured.purpose, "rss-reader-translate");
  assert.equal(captured.messages.length, 1);
  assert.equal(captured.messages[0].role, "user");
});

test("a chosen thinking intensity reaches the model call, and none is absent", async () => {
  let captured;
  const llm = fakeLlm('{"title":"t","markdown":"m"}', { capture: (options) => { captured = options; } });
  await translateItem({ llm, provider: "p", model: "m", effort: "low" }, ITEM);
  assert.equal(captured.reasoningEffort, "low");

  // Empty means "the model's own default": naming an effort would override a
  // deployment's choice, so the field must be left off entirely.
  await translateItem({ llm, provider: "p", model: "m", effort: "" }, ITEM);
  assert.equal("reasoningEffort" in captured, false);
});

test("the output budget grows with the body instead of staying fixed", () => {
  // The configured value is the floor, never lowered.
  assert.equal(maxTokensFor(0, 4000), 4000);
  assert.equal(maxTokensFor(100, 4000), 4000);
  // A long article needs room for the translation plus the reasoning that
  // precedes it — a fixed cap is what made long articles come back empty.
  const longBody = 12000;
  assert.ok(maxTokensFor(longBody, 4000) > 4000, "a long body must raise the budget");
  assert.ok(maxTokensFor(longBody, 4000) >= longBody / 4, "and at least cover the source itself");
  // Monotonic in body size, and never past the ceiling.
  assert.ok(maxTokensFor(30000, 4000) >= maxTokensFor(12000, 4000));
  assert.equal(maxTokensFor(1_000_000, 4000), MAX_TRANSLATE_MAX_TOKENS);
  // An operator who raises the floor keeps it.
  assert.equal(maxTokensFor(100, 9000), 9000);
});

test("a translation cut off by the token cap says so instead of blaming the model", async () => {
  // The failing shape: the model hit the cap, so there is no text block at all.
  const llm = {
    stream() {
      return (async function* generate() {
        yield { type: "block-start", index: 0, blockType: "reasoning" };
        yield { type: "reasoning-delta", index: 0, text: "thinking about it" };
        yield { type: "finish", reason: { kind: "max-tokens" } };
      })();
    }
  };
  const result = await translateItem({ llm, provider: "p", model: "m" }, ITEM);
  assert.equal(result.status, "failed");
  assert.match(result.error, /截断/, "the reader must be told it ran out of room, not that the model said nothing");
  assert.match(result.error, /translateMaxTokens/, "and which knob to turn");
});

test("a model that returns nothing without hitting the cap keeps the original wording", async () => {
  const llm = {
    stream() {
      return (async function* generate() {
        yield { type: "block-start", index: 0, blockType: "reasoning" };
        yield { type: "reasoning-delta", index: 0, text: "hmm" };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    }
  };
  const result = await translateItem({ llm, provider: "p", model: "m" }, ITEM);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "the model returned no text");
});

test("translateItem reports a failure instead of throwing", async () => {
  const llm = fakeLlm(new Error("model exploded"));
  const result = await translateItem({ llm, provider: "p", model: "m" }, ITEM);
  assert.equal(result.status, "failed");
  assert.match(result.error, /model exploded/);
});

test("translateItem explains a missing LLM service", async () => {
  const result = await translateItem({ llm: undefined, provider: "p", model: "m" }, ITEM);
  assert.equal(result.status, "failed");
  assert.match(result.error, /LLM service is not available/);
});

test("translateItem explains a missing model route", async () => {
  const llm = fakeLlm("x");
  for (const route of [{ provider: "", model: "m" }, { provider: "p", model: "" }]) {
    const result = await translateItem({ llm, ...route }, ITEM);
    assert.equal(result.status, "failed");
    assert.match(result.error, /no model is configured/);
  }
});

test("translateItem refuses an item with nothing to translate", async () => {
  const llm = fakeLlm('{"title":"t","markdown":"m"}');
  const result = await translateItem({ llm, provider: "p", model: "m" }, { title: "", markdown: "", content: "" });
  assert.equal(result.status, "failed");
  assert.match(result.error, /no title or body/);
});

test("translateItem reports an empty model response", async () => {
  const llm = fakeLlm("");
  const result = await translateItem({ llm, provider: "p", model: "m" }, ITEM);
  assert.equal(result.status, "failed");
  assert.match(result.error, /no text/);
});

test("translateItem reports a timeout rather than hanging", async () => {
  const llm = {
    stream() {
      return (async function* generate() {
        // Never yields: the abort timer must end this.
        await new Promise(() => {});
      })();
    }
  };
  const result = await translateItem({ llm, provider: "p", model: "m" }, { ...ITEM, timeoutMs: 40 });
  assert.equal(result.status, "failed");
  assert.match(result.error, /timed out/);
});

test("translateItem honours caller cancellation", async () => {
  const llm = {
    stream() {
      return (async function* generate() {
        await new Promise(() => {});
      })();
    }
  };
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("user navigated away")), 30);
  const result = await translateItem({ llm, provider: "p", model: "m" }, { ...ITEM, signal: controller.signal, timeoutMs: 5000 });
  assert.equal(result.status, "failed");
  assert.match(result.error, /user navigated away/);
});

test("translateItem truncates a very long body and reports it", async () => {
  let captured;
  const llm = fakeLlm('{"title":"t","markdown":"m"}', { capture: (options) => { captured = options; } });
  let truncatedBy = 0;
  await translateItem({ llm, provider: "p", model: "m" }, {
    title: "T",
    markdown: "x".repeat(20000),
    onTruncated: (amount) => { truncatedBy = amount; }
  });
  assert.ok(truncatedBy > 0, "the caller should learn that the body was cut");
  const sent = captured.messages[0].content.map((part) => part.text ?? "").join("");
  assert.ok(sent.length < 20000, "the prompt must not carry the whole oversized body");
});
