/**
 * dsh-rss-reader — one-click translation.
 *
 * Translates an item's title and body through the harness LLM service, so the
 * user's configured model and credentials are reused rather than a second API
 * key being configured.
 *
 * Two properties matter more than raw prompt quality here:
 *
 * - **Markdown in, Markdown out**: the body is converted to Markdown upstream,
 *   so link targets, list structure and image syntax survive the round trip and
 *   render through the same path as the original.
 * - **Structure is preserved**: the model is asked for a strict JSON object
 *   with the translated title and body, so a returned translation can never be
 *   mistaken for new content and the original stays untouched beside it.
 *
 * Translation is cached per item on the host, so re-opening an item costs
 * nothing and switching back to the original is instant.
 *
 * @module dsh-rss-reader/translate
 */

/** Language presets offered in the UI, mapped to the instruction text. */
export const TARGET_LANGUAGES = {
  "zh-CN": "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  en: "English",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  fr: "French (Français)",
  de: "German (Deutsch)",
  es: "Spanish (Español)",
  ru: "Russian (Русский)",
  pt: "Portuguese (Português)"
};

/** Default target when the caller does not pick one. */
export const DEFAULT_TARGET = "zh-CN";

/** Cap on the body sent to the model, in characters. */
const MAX_TRANSLATE_CHARS = 12000;

/**
 * Rough characters per token for the Markdown bodies feeds publish.
 *
 * Only used to size the output budget, so the estimate deliberately errs high:
 * under-estimating the budget is what makes a translation come back empty.
 */
const CHARS_PER_TOKEN = 4;

/**
 * How much output room a translation needs, beyond the configured floor.
 *
 * A translation is about as long as its source, and a reasoning model spends
 * part of the same budget thinking before it writes anything — so the cap has to
 * cover roughly *twice* the token count of the source before any of it becomes
 * visible text. When the cap runs out during that thinking the model never
 * emits a text block at all, and the caller sees "the model returned no text"
 * for an article that is merely long. Hence the generous multiplier: it is
 * cheap next to a failed translation that the reader has to retry by hand.
 *
 * @param {number} bodyChars - characters of source actually being sent.
 * @param {number} configured - the configured floor.
 * @returns {number} the token cap to request.
 */
export function maxTokensFor(bodyChars, configured) {
  const floor = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_TRANSLATE_MAX_TOKENS;
  const estimated = Math.ceil(bodyChars / CHARS_PER_TOKEN);
  // Translation (~1x the source) + a long reasoning pass + the JSON wrapper.
  const wanted = estimated * 4 + 1200;
  // Never lower what the operator configured, and keep a runaway body from
  // asking for an absurd budget.
  return Math.max(floor, Math.min(wanted, MAX_TRANSLATE_MAX_TOKENS));
}

/** Default per-request budget. */
export const DEFAULT_TRANSLATE_TIMEOUT_MS = 90000;

/** Default output-token floor for a translation call. */
export const DEFAULT_TRANSLATE_MAX_TOKENS = 4000;

/**
 * Hard ceiling on the output budget one translation may ask for.
 *
 * Well above what the 12,000-character source cap needs even with heavy
 * reasoning, because the cost of being too low is a failed translation while
 * the cost of being too high is only an unused reservation.
 */
export const MAX_TRANSLATE_MAX_TOKENS = 64000;

/**
 * Normalize a requested target language.
 *
 * Accepts a known preset code, or any free-text description (so a user can ask
 * for a language the presets do not list).
 *
 * @param {unknown} value - requested target.
 * @returns {string} the instruction text to embed in the prompt.
 */
export function normalizeTarget(value) {
  if (typeof value !== "string") return TARGET_LANGUAGES[DEFAULT_TARGET];
  const raw = value.trim();
  if (raw.length === 0) return TARGET_LANGUAGES[DEFAULT_TARGET];
  if (Object.hasOwn(TARGET_LANGUAGES, raw)) return TARGET_LANGUAGES[raw];
  // A bare code that is not a preset is passed through as a language name.
  if (/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(raw)) return raw;
  return raw;
}

/**
 * Split a Markdown body into the top-level blocks a reader sees.
 *
 * Blocks are separated by blank lines, except inside a fenced code block — a
 * blank line in the middle of a code sample does not start a new paragraph. The
 * split is what makes a side-by-side view possible: the reader's body and the
 * model's translation are compared block by block, so both sides must be cut at
 * the same places.
 *
 * @param {string} markdown - the body.
 * @returns {string[]} blocks in source order, without surrounding blank lines.
 */
export function splitMarkdownBlocks(markdown) {
  const text = typeof markdown === "string" ? markdown.replace(/\r\n?/g, "\n") : "";
  if (text.trim().length === 0) return [];
  const blocks = [];
  let current = [];
  let fence = null;
  const flush = () => {
    const joined = current.join("\n").trim();
    if (joined.length > 0) blocks.push(joined);
    current = [];
  };
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null && marker !== null) {
      fence = marker[1][0];
    } else if (fence !== null && marker !== null) {
      fence = null;
    }
    if (fence === null && line.trim().length === 0) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * Whether a block is pure structure rather than prose.
 *
 * A lone image or a code sample has nothing to translate, so asking for it
 * again would only duplicate what the original already shows — and it is also
 * the answer the prompt tells the model to give for those blocks (an empty
 * translation), which keeps the two sides index-aligned.
 *
 * @param {string} block - one Markdown block.
 * @returns {boolean} true when there is no prose in it.
 */
export function isStructuralBlock(block) {
  const text = typeof block === "string" ? block.trim() : "";
  if (text.length === 0) return true;
  // A fenced code block.
  if (/^(`{3,}|~{3,})/.test(text)) return true;
  // Only image(s), no other text.
  if (/^!\[[^\]]*\]\([^)]*\)$/.test(text)) return true;
  const withoutImages = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
  return withoutImages.length === 0;
}

/**
 * Pull the numbered translation objects out of a model response.
 *
 * Accepts the object the prompt asks for and the common shapes models fall back
 * to — a bare array, or an object under a different key — because a usable
 * side-by-side view is better than a hard failure over a wrapper name.
 *
 * @param {string} text - raw model text.
 * @returns {{title: string, items: Array<{index: number, text: string}>} | null} parsed result.
 */
export function extractSegmentResult(text) {
  if (typeof text !== "string") return null;
  const parsed = extractJsonObject(text);
  const root = parsed ?? extractJsonArray(text);
  if (root === null) return null;
  const list = Array.isArray(root)
    ? root
    : (Array.isArray(root.segments) ? root.segments : (Array.isArray(root.translations) ? root.translations : null));
  if (list === null) return null;
  const items = [];
  for (const entry of list) {
    if (typeof entry === "string") {
      // A bare string array: position is the only index available.
      items.push({ index: items.length + 1, text: entry });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const index = Number(entry.index ?? entry.id ?? entry.n);
    const body = typeof entry.text === "string"
      ? entry.text
      : (typeof entry.markdown === "string" ? entry.markdown : (typeof entry.translation === "string" ? entry.translation : ""));
    if (!Number.isFinite(index)) continue;
    items.push({ index: Math.trunc(index), text: body });
  }
  if (items.length === 0) return null;
  return {
    title: !Array.isArray(root) && typeof root.title === "string" ? root.title.trim() : "",
    items
  };
}

/**
 * Extract the first JSON array from a model response.
 *
 * @param {string} text - raw model text.
 * @returns {unknown[] | null} the parsed array, or null.
 */
export function extractJsonArray(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Build the translation prompt.
 *
 * The rules exist because feed bodies are Markdown full of links, code and
 * images: a model that "helpfully" rewrites URLs, translates code identifiers,
 * or drops image syntax produces output that no longer renders.
 *
 * The body is sent as **numbered segments** and the model is asked to answer per
 * segment. That is what makes the side-by-side view possible: the reader's own
 * blocks and the returned segments line up, so each paragraph can be shown with
 * its translation directly beneath it.
 *
 * @param {object} input - `{title, markdown, target, summary, segments}`.
 * @returns {string} the user prompt.
 */
export function buildTranslatePrompt({ title, markdown, summary, target, segments }) {
  const language = normalizeTarget(target);
  // A caller that already split the body passes it in, so the prompt and the
  // alignment use exactly the same cuts.
  const blocks = Array.isArray(segments) ? segments : splitMarkdownBlocks(markdown);
  const numbered = blocks.length > 0 && !(blocks.length === 1 && isStructuralBlock(blocks[0]));
  const lines = [];
  lines.push(`Translate the following article into ${language}.`);
  lines.push("");
  lines.push("Rules:");
  lines.push("1. Translate the title and every numbered segment. Keep the wording natural and idiomatic for the target language.");
  lines.push("2. The segments are Markdown. Preserve ALL Markdown syntax exactly: headings, lists, emphasis, block quotes, tables, fenced code blocks and inline code.");
  lines.push("3. Do NOT translate or alter URLs, link targets, image paths, file names, or code inside code blocks and inline code. Copy them byte for byte.");
  lines.push("4. Do NOT add commentary, notes, explanations, prefaces, or a summary of your own.");
  lines.push("5. If a passage is already in the target language, keep it as it is.");
  lines.push("6. Translate the image alt text, but keep the image URL unchanged.");
  lines.push("7. Keep exactly one entry per segment, in the same order. A segment that is only an image or only a code sample has nothing to translate — return an empty string for it.");
  lines.push("");
  lines.push(`Article title:\n${typeof title === "string" ? title : ""}`);
  // A summary that merely repeats the body would be sent twice, doubling the
  // prompt for no benefit. Compare against the body, not the title.
  const trimmedSummary = typeof summary === "string" ? summary.trim() : "";
  const trimmedBody = typeof markdown === "string" ? markdown.trim() : "";
  if (trimmedSummary.length > 0 && trimmedSummary !== trimmedBody) {
    lines.push("");
    lines.push(`Article summary (translate it too):\n${trimmedSummary}`);
  }
  lines.push("");
  lines.push("Article segments (numbered, in order):");
  if (numbered) {
    for (const [index, block] of blocks.entries()) {
      lines.push("");
      lines.push(`${index + 1}.`);
      lines.push(block);
    }
  } else {
    lines.push(typeof markdown === "string" && markdown.length > 0 ? markdown : "(empty)");
  }
  lines.push("");
  lines.push("Respond with ONLY one JSON object, with no markdown fences and no prose outside it:");
  if (numbered) {
    lines.push('{"title":"<translated title>","segments":[{"index":1,"text":"<segment 1>"},{"index":2,"text":"<segment 2>"}]}');
    lines.push(`Include every index from 1 to ${blocks.length}, in order.`);
  } else {
    lines.push('{"title":"<translated title>","markdown":"<translated body as Markdown>"}');
  }
  return lines.join("\n");
}

/**
 * Extract the first JSON object from a model response.
 *
 * Models wrap JSON in prose or code fences despite instructions, so this reads
 * the first balanced object rather than trusting the whole string to parse.
 *
 * @param {string} text - raw model text.
 * @returns {object | null} the parsed object, or null.
 */
export function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Normalize a model response into a stored translation.
 *
 * Falls back to treating the whole response as the body when the model ignored
 * the JSON instruction — a usable translation is better than a hard failure,
 * and the caller can still fall back to the original.
 *
 * @param {string} text - raw model text.
 * @param {{title?: string}} [fallback] - the original fields.
 * @returns {{title: string, markdown: string} | null} the translation, or null when unusable.
 */
export function normalizeTranslation(text, fallback = {}) {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  const parsed = extractJsonObject(text);
  if (parsed !== null) {
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const markdown = typeof parsed.markdown === "string"
      ? parsed.markdown
      : typeof parsed.body === "string" ? parsed.body : "";
    if (markdown.trim().length === 0 && title.length === 0) return null;
    return {
      title: title.length > 0 ? title : (fallback.title ?? ""),
      markdown: markdown.trim().length > 0 ? markdown.trim() : ""
    };
  }
  // No JSON: strip a code fence and accept the text as the body.
  const unfenced = text.trim().replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```$/, "").trim();
  if (unfenced.length === 0) return null;
  return { title: fallback.title ?? "", markdown: unfenced };
}

/**
 * Pair source blocks with the translations the model returned for them.
 *
 * A side-by-side view is only trustworthy when the answer covers **every**
 * block: a missing or extra entry means the model merged, split or dropped
 * something, and pairing by position from there would print one paragraph's
 * translation under another. So this is all-or-nothing by design — an empty
 * result is the caller's signal to fall back to the whole-body translation.
 *
 * @param {string[]} blocks - the source blocks, in order.
 * @param {Array<{index: number, text: string}>} items - the model's entries.
 * @returns {Array<{source: string, translated: string}>} aligned pairs, or [].
 */
export function alignSegments(blocks, items) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  if (!Array.isArray(items) || items.length !== blocks.length) return [];
  const byIndex = new Map();
  for (const item of items) {
    // A repeated index means the model lost track of the numbering.
    if (byIndex.has(item.index)) return [];
    byIndex.set(item.index, typeof item.text === "string" ? item.text.trim() : "");
  }
  const aligned = [];
  for (const [position, block] of blocks.entries()) {
    const translated = byIndex.get(position + 1);
    if (translated === undefined) return [];
    aligned.push({ source: block, translated });
  }
  // A translation that dropped every block is not a translation.
  if (aligned.every((entry) => entry.translated.length === 0)) return [];
  return aligned;
}

/** Reject as soon as `signal` aborts, with its reason. */
function abortPromise(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}

/**
 * Iterate a stream, giving up as soon as `signal` aborts.
 *
 * Aborting a signal does not by itself interrupt `for await` over a stream that
 * simply stops producing: the iterator would stay pending forever while the
 * timer that was supposed to bound the call had already fired. Racing each
 * `next()` against the signal is what actually bounds the call.
 *
 * Cleanup deliberately does NOT await `iterator.return()`: a producer that
 * never resolves its `next()` generally does not resolve its `return()` either,
 * so awaiting it would reintroduce the very hang this guards against. Closing
 * is requested and any promise it returns is abandoned.
 *
 * @param {AsyncIterable<object>} iterable - the model's chunk stream.
 * @param {AbortSignal} signal - caller/timeout cancellation.
 * @returns {AsyncGenerator<object>} the bounded stream of chunks.
 */
async function* iterateUntilAborted(iterable, signal) {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await Promise.race([iterator.next(), abortPromise(signal)]);
      if (step.done === true) return;
      yield step.value;
    }
  } finally {
    // Fire-and-forget: release the producer without waiting on it.
    try {
      iterator.return?.()?.catch?.(() => {});
    } catch {
      /* the stream may already be closed */
    }
  }
}

/**
 * Translate one item.
 *
 * Never throws: a failure is returned as `{status: "failed"}` with a message,
 * so the UI can report it and keep showing the original.
 *
 * @param {object} deps - collaborators.
 * @param {object} deps.llm - harness LLM service (`ctx.llm`).
 * @param {string} deps.provider - model provider id.
 * @param {string} deps.model - model id.
 * @param {string} [deps.effort] - thinking intensity; empty uses the model default.
 * @param {object} input - `{title, markdown, summary, target, signal, timeoutMs, sessionId}`.
 * @returns {Promise<{status: "ok", title: string, markdown: string, target: string,
 *   model: string, at: string} | {status: "failed", error: string}>} the outcome.
 */
export async function translateItem(deps, input) {
  const { llm, provider, model, effort } = deps;
  const targetCode = typeof input.target === "string" && input.target.length > 0 ? input.target : DEFAULT_TARGET;
  const language = normalizeTarget(targetCode);

  if (llm === undefined || llm === null) {
    return { status: "failed", error: "the harness LLM service is not available in this profile" };
  }
  if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0) {
    return { status: "failed", error: "no model is configured; set provider and model in the plugin config" };
  }
  const body = typeof input.markdown === "string" && input.markdown.length > 0 ? input.markdown : input.content ?? "";
  if (String(body).trim().length === 0 && String(input.title ?? "").trim().length === 0) {
    return { status: "failed", error: "this item has no title or body to translate" };
  }
  const source = String(body).slice(0, MAX_TRANSLATE_CHARS);
  if (String(body).length > MAX_TRANSLATE_CHARS) {
    input.onTruncated?.(String(body).length - MAX_TRANSLATE_CHARS);
  }

  const timeoutMs = input.timeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal?.reason ?? new Error("aborted"));
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("translation timed out")), timeoutMs);

  try {
    // Imported lazily so this module (and its pure prompt helpers) load in
    // unit tests without the harness runtime present. Note `deepFreeze` lives
    // in `dsh-util-values`, NOT in `dsh-llm` — asking `dsh-llm` for it yields
    // `undefined` and throws only at call time.
    const { BlockAssembler, createUserMessage } = await import("@deepseek-ai/dsh-llm");
    // The same cuts the prompt uses, so a returned segment index maps onto the
    // reader's own block without guessing where the article was split.
    const segments = splitMarkdownBlocks(source);
    const messages = [createUserMessage({
      content: [{ type: "text", text: buildTranslatePrompt({
        title: input.title,
        markdown: source,
        summary: input.summary,
        target: targetCode,
        segments
      }) }],
      source: { kind: "plugin", plugin: "dsh-rss-reader" }
    })];
    const streamOptions = {
      provider,
      model,
      messages,
      system: "You are a professional translator. You translate articles faithfully and preserve all Markdown syntax, URLs and code exactly. You always answer with the requested JSON object only.",
      // Sized to the body: a fixed cap that fits a short note leaves a long
      // article's translation unfinished, and an unfinished one has no text
      // block at all — which reads as "the model returned no text".
      maxTokens: maxTokensFor(source.length, input.maxTokens),
      // Thinking intensity is the other half of that budget: on a reasoning
      // model "high" can spend the whole cap before writing a word, so a reader
      // who picks a lighter effort gets long articles translated where the
      // model default would have run out.
      ...(typeof effort === "string" && effort.length > 0 ? { reasoningEffort: effort } : {}),
      ...(typeof input.sessionId === "string" && input.sessionId.length > 0 ? { sessionId: input.sessionId } : {}),
      purpose: "rss-reader-translate",
      signal: controller.signal
    };

    const assembler = new BlockAssembler();
    let finishKind = "";
    for await (const chunk of iterateUntilAborted(llm.stream(streamOptions), controller.signal)) {
      if (chunk !== null && chunk !== undefined && chunk.type === "finish") {
        finishKind = chunk.reason?.kind ?? "";
      }
      assembler.push(chunk);
    }
    controller.signal.throwIfAborted();

    const text = assembler.blocks()
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text.length === 0) {
      // Name the cap when the model ran out of room: "no text" reads like a
      // broken model, while "hit the N-token limit" points at the real cause —
      // and at the two settings that fix it.
      if (finishKind === "max-tokens") {
        return {
          status: "failed",
          error: `模型在输出 ${streamOptions.maxTokens} tokens 时被截断，没有留下可用的译文。`
            + `到「设置 → RSS 阅读器 → 翻译模型」换一个更轻的模型或把思考强度调到最低；`
            + `也可以把 translateMaxTokens 调大。`
        };
      }
      return { status: "failed", error: "the model returned no text" };
    }

    // Prefer the segment-aligned answer: it is what lets the reader see each
    // paragraph beside its translation. A model that answered with one block of
    // Markdown still yields a usable — if less precisely aligned — result.
    const perSegment = extractSegmentResult(text);
    const normalized = perSegment === null
      ? normalizeTranslation(text, { title: input.title })
      : null;
    if (perSegment === null && normalized === null) {
      return { status: "failed", error: "the model returned no usable translation" };
    }
    if (perSegment !== null && normalized === null && perSegment.items.length === 0) {
      return { status: "failed", error: "the model returned no usable translation" };
    }

    const aligned = perSegment === null
      ? []
      : alignSegments(segments, perSegment.items);
    const markdown = perSegment === null
      ? normalized.markdown
      : aligned.map((entry) => entry.translated).filter((entry) => entry.length > 0).join("\n\n");
    if (markdown.trim().length === 0) {
      return { status: "failed", error: "the model returned no usable translation" };
    }

    return {
      status: "ok",
      title: perSegment === null ? normalized.title : (perSegment.title.length > 0 ? perSegment.title : (input.title ?? "")),
      markdown,
      // Only worth storing when it actually lines up with the source: a partially
      // aligned answer would put translations beside the wrong paragraphs, and
      // the reader is better served by the plain whole-body view than by a
      // confidently wrong side-by-side one.
      ...(aligned.length > 0 ? { segments: aligned.map((entry) => entry.translated) } : {}),
      target: targetCode,
      language,
      model: `${provider}/${model}`,
      at: new Date().toISOString()
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" || controller.signal.aborted) {
      const reason = controller.signal.reason;
      const message = reason instanceof Error ? reason.message : "translation aborted";
      return { status: "failed", error: message === "translation timed out" ? `translation timed out after ${timeoutMs}ms` : message };
    }
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
