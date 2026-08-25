import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import register, {
  commentFocusOffset,
  commentSort,
  FileReviewComponent,
  formatRange,
  formatReviewFeedback,
  loadSource,
  rangesIntersect,
  sourceExcerpt,
  validateRange,
  wrapSourceLine,
} from "../extensions/marginalia.ts";

const theme = {
  fg(_name: string, text: string) { return text; },
  bg(_name: string, text: string) { return text; },
};

function makeTui(rows = 40): any {
  return { terminal: { rows }, requestRender() {} };
}

test("validates ranges and formats excerpts", () => {
  assert.deepEqual(validateRange({ startLine: 2, endLine: 3 }, 4, "comment"), { startLine: 2, endLine: 3 });
  assert.equal(formatRange({ startLine: 2, endLine: 2 }), "2");
  assert.equal(formatRange({ startLine: 2, endLine: 3 }), "2-3");
  assert.equal(sourceExcerpt(["one", "two", "three"], { startLine: 2, endLine: 3 }), "two\nthree");
  assert.throws(() => validateRange({ startLine: 0, endLine: 1 }, 4, "comment"), /invalid line range/);
  assert.throws(() => validateRange({ startLine: 3, endLine: 2 }, 4, "comment"), /invalid line range/);
  assert.equal(rangesIntersect({ startLine: 2, endLine: 3 }, { startLine: 3, endLine: 5 }), true);
  assert.equal(rangesIntersect({ startLine: 2, endLine: 3 }, { startLine: 4, endLine: 5 }), false);
});

test("orders comments by source position and stages feedback in that order", () => {
  const comments = [
    { id: "agent-2", startLine: 20, endLine: 20, text: "later" },
    { id: "agent-1", startLine: 4, endLine: 8, text: "first" },
  ];
  assert.equal([...comments].sort(commentSort)[0]?.id, "agent-1");
  const review = formatReviewFeedback(
    "/tmp/flake.nix",
    Array.from({ length: 20 }, (_, index) => `line ${index + 1}`),
    [],
    [
      { id: "user-20", startLine: 20, endLine: 20, text: "Later" },
      { id: "user-3", startLine: 3, endLine: 3, text: "Earlier" },
    ],
  );
  assert.ok(review.indexOf("Lines 3") < review.indexOf("Lines 20"));

  const threaded = formatReviewFeedback(
    "/tmp/flake.nix",
    ["line one", "line two", "line three"],
    [{ id: "agent-1", startLine: 2, endLine: 2, text: "Check this" }],
    [
      { id: "user-1", startLine: 2, endLine: 2, text: "I agree", parentId: "agent-1" },
      { id: "user-2", startLine: 3, endLine: 3, text: "Another point" },
    ],
  );
  assert.match(threaded, /Reply to PI comment on Lines 2/);
  assert.match(threaded, /PI comment: Check this/);
  assert.match(threaded, /Annotation on Lines 3/);
});

test("wraps source rows and focuses comments with two lines of context", () => {
  assert.equal(wrapSourceLine("0123456789", 4, false).length, 1);
  assert.equal(wrapSourceLine("0123456789", 4, true).length, 3);
  assert.equal(commentFocusOffset(6, [0, 1, 2, 3, 4, 5, 6, 7], 4, 7), 3);
  assert.equal(commentFocusOffset(1, [0, 1, 2], 4, 2), 0);
});

test("source movement selects an intersecting comment without expanding to its range", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three", "four", "five"],
    ["one", "two", "three", "four", "five"],
    [{ id: "agent-1", startLine: 2, endLine: 4, text: "Review these lines" }], "hash", async () => Buffer.from(""), () => {},
  );

  component.handleInput("j");

  assert.equal((component as any).selectedComment()?.id, "agent-1");
  assert.deepEqual((component as any).selectedRange(), { startLine: 2, endLine: 2 });
});

test("reply begins from a source-selected PI comment without tabbing", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three"], ["one", "two", "three"],
    [{ id: "agent-1", startLine: 2, endLine: 2, text: "Check line two" }], "hash", async () => Buffer.from(""), () => {},
  );

  component.handleInput("j");
  component.handleInput("r");
  for (const character of "direct reply") component.handleInput(character);
  component.handleInput("\r");

  assert.match(component.render(100).join("\n"), /direct reply/);
});

test("source ranges keep the intersecting comment selected without snapping subset or superset", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three", "four", "five"],
    ["one", "two", "three", "four", "five"],
    [{ id: "agent-1", startLine: 2, endLine: 4, text: "Review these lines" }], "hash", async () => Buffer.from(""), () => {},
  );

  component.handleInput("j");
  component.handleInput("J");
  assert.equal((component as any).selectedComment()?.id, "agent-1");
  assert.deepEqual((component as any).selectedRange(), { startLine: 2, endLine: 3 });

  component.handleInput("J");
  assert.equal((component as any).selectedComment()?.id, "agent-1");
  assert.deepEqual((component as any).selectedRange(), { startLine: 2, endLine: 4 });

  component.handleInput("J");
  assert.equal((component as any).selectedComment()?.id, "agent-1");
  assert.deepEqual((component as any).selectedRange(), { startLine: 2, endLine: 5 });

  component.handleInput("k");
  assert.equal((component as any).selectedComment()?.id, "agent-1");
  assert.deepEqual((component as any).selectedRange(), { startLine: 4, endLine: 4 });

  component.handleInput("j");
  assert.equal((component as any).selectedComment(), undefined);
  assert.deepEqual((component as any).selectedRange(), { startLine: 5, endLine: 5 });
});

test("a partial source overlap selects the comment without moving either range edge", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three", "four"],
    ["one", "two", "three", "four"],
    [{ id: "agent-1", startLine: 2, endLine: 4, text: "Review these lines" }], "hash", async () => Buffer.from(""), () => {},
  );

  component.handleInput("J");

  assert.equal((component as any).selectedComment()?.id, "agent-1");
  assert.deepEqual((component as any).selectedRange(), { startLine: 1, endLine: 2 });
});

test("overlapping source comments preserve the active one until the range leaves it", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three", "four", "five"],
    ["one", "two", "three", "four", "five"],
    [
      { id: "agent-a", startLine: 2, endLine: 4, text: "First overlap" },
      { id: "agent-b", startLine: 4, endLine: 5, text: "Second overlap" },
    ], "hash", async () => Buffer.from(""), () => {},
  );

  component.handleInput("j");
  component.handleInput("j");
  assert.equal((component as any).selectedComment()?.id, "agent-a");

  component.handleInput("\t");
  assert.equal((component as any).selectedComment()?.id, "agent-b");

  component.handleInput("k");
  assert.equal((component as any).selectedComment()?.id, "agent-b");

  component.handleInput("k");
  assert.equal((component as any).selectedComment()?.id, "agent-a");
});

test("an active longer comment survives entering a nested comment start line", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three", "four", "five"],
    ["one", "two", "three", "four", "five"],
    [
      { id: "agent-long", startLine: 2, endLine: 5, text: "Long comment" },
      { id: "agent-nested", startLine: 3, endLine: 3, text: "Nested comment" },
    ], "hash", async () => Buffer.from(""), () => {},
  );

  component.handleInput("j");
  component.handleInput("j");

  assert.equal((component as any).selectedComment()?.id, "agent-long");
  assert.deepEqual((component as any).selectedRange(), { startLine: 3, endLine: 3 });
});

test("tab navigation starts from the active source line instead of the selected comment", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", Array.from({ length: 8 }, (_, index) => `line ${index + 1}`),
    Array.from({ length: 8 }, (_, index) => `line ${index + 1}`),
    [
      { id: "agent-a", startLine: 2, endLine: 6, text: "Long comment" },
      { id: "agent-b", startLine: 4, endLine: 4, text: "Middle comment" },
      { id: "agent-c", startLine: 8, endLine: 8, text: "Last comment" },
    ], "hash", async () => Buffer.from(""), () => {},
  );

  component.handleInput("\t");
  component.handleInput("J");
  component.handleInput("J");
  assert.deepEqual((component as any).selectedRange(), { startLine: 2, endLine: 8 });
  assert.equal((component as any).selectedComment()?.id, "agent-a");

  component.handleInput("\t");
  assert.equal((component as any).selectedComment()?.id, "agent-a");

  component.handleInput("\x1b[Z");
  assert.equal((component as any).selectedComment()?.id, "agent-b");
});

test("tab navigation keeps comments with the same range reachable", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three", "four"],
    ["one", "two", "three", "four"],
    [
      { id: "agent-a", startLine: 2, endLine: 2, text: "First same-line comment" },
      { id: "agent-b", startLine: 2, endLine: 2, text: "Second same-line comment" },
      { id: "agent-c", startLine: 4, endLine: 4, text: "Later comment" },
    ], "hash", async () => Buffer.from(""), () => {},
  );

  component.handleInput("j");
  assert.equal((component as any).selectedComment()?.id, "agent-a");

  component.handleInput("\t");
  assert.equal((component as any).selectedComment()?.id, "agent-b");

  component.handleInput("\t");
  assert.equal((component as any).selectedComment()?.id, "agent-c");

  component.handleInput("\x1b[Z");
  assert.equal((component as any).selectedComment()?.id, "agent-b");

  component.handleInput("\x1b[Z");
  assert.equal((component as any).selectedComment()?.id, "agent-a");
});

test("home and end select comments on their destination lines", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three"], ["one", "two", "three"],
    [
      { id: "agent-first", startLine: 1, endLine: 1, text: "First line" },
      { id: "agent-last", startLine: 3, endLine: 3, text: "Last line" },
    ], "hash", async () => Buffer.from(""), () => {},
  );

  component.handleInput("G");
  assert.equal((component as any).selectedComment()?.id, "agent-last");

  component.handleInput("g");
  assert.equal((component as any).selectedComment()?.id, "agent-first");
});

test("extends a selected multiline comment in both directions", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three", "four", "five", "six"],
    ["one", "two", "three", "four", "five", "six"],
    [{ id: "agent-1", startLine: 2, endLine: 4, text: "Review these lines" }], "hash", async () => Buffer.from(""), () => {},
  );
  component.handleInput("\t");
  component.handleInput("J");
  assert.deepEqual((component as any).selectedRange(), { startLine: 2, endLine: 5 });

  const upward = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three", "four", "five", "six"],
    ["one", "two", "three", "four", "five", "six"],
    [{ id: "agent-1", startLine: 2, endLine: 4, text: "Review these lines" }], "hash", async () => Buffer.from(""), () => {},
  );
  upward.handleInput("\t");
  upward.handleInput("K");
  assert.deepEqual((upward as any).selectedRange(), { startLine: 1, endLine: 4 });
});

test("supports reply, edit, and delete flows", () => {
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three"], ["one", "two", "three"],
    [{ id: "agent-1", startLine: 2, endLine: 2, text: "Check line two" }], "hash", async () => Buffer.from(""), () => {},
  );
  component.handleInput("\t");
  component.handleInput("r");
  for (const character of "reply") component.handleInput(character);
  component.handleInput("\r");
  assert.match(component.render(100).join("\n"), /reply/);

  component.handleInput("e");
  for (let index = 0; index < 5; index++) component.handleInput("\x7f");
  for (const character of "edited") component.handleInput(character);
  component.handleInput("\r");
  assert.match(component.render(100).join("\n"), /edited/);

  component.handleInput("d");
  assert.doesNotMatch(component.render(100).join("\n"), /edited/);
});

test("bounds rendering to tiny terminal heights", () => {
  const component = new FileReviewComponent(
    makeTui(3), theme as any, "/tmp/source.nix", ["one", "two", "three"], ["one", "two", "three"],
    [{ id: "agent-1", startLine: 2, endLine: 2, text: "Check line two" }], "hash", async () => Buffer.from(""), () => {},
  );
  assert.ok(component.render(80).length <= 3);
  assert.ok(component.render(2).length <= 3);
});

test("submits unchanged component feedback and refuses stale content", async () => {
  let result: unknown;
  let current = Buffer.from("one\ntwo\nthree");
  const component = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three"], ["one", "two", "three"],
    [], createHash("sha256").update(current).digest("hex"), async () => current, (value) => { result = value; },
  );
  component.handleInput("a");
  for (const character of "Keep") component.handleInput(character);
  component.handleInput("\r");
  component.handleInput("s");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((result as any).cancelled, false);
  assert.equal((result as any).comments[0].text, "Keep");

  result = undefined;
  const stale = new FileReviewComponent(
    makeTui(), theme as any, "/tmp/source.nix", ["one", "two", "three"], ["one", "two", "three"],
    [], "hash", async () => Buffer.from("changed"), (value) => { result = value; },
  );
  stale.handleInput("s");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result, undefined);
  assert.match(stale.render(100).join("\n"), /Source changed/);
});

test("loads relative UTF-8 source and rejects binary data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-marginalia-"));
  await writeFile(join(directory, "source.nix"), "one\ntwo\n", "utf8");
  const source = await loadSource("source.nix", directory);
  assert.equal(source.lines[1], "two");
  assert.equal(source.absolutePath, join(directory, "source.nix"));

  await writeFile(join(directory, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(() => loadSource("binary.bin", directory), /binary/);
});

test("registers annotate_file and stages feedback without sending it", async () => {
  let tool: any;
  register({ registerTool(value: unknown) { tool = value; } } as any);
  const directory = await mkdtemp(join(tmpdir(), "pi-marginalia-tool-"));
  const path = join(directory, "source.txt");
  const original = "one\ntwo\nthree\n";
  await writeFile(path, original, "utf8");
  let composer = "";
  let aborted = false;
  const ctx: any = {
    mode: "tui", cwd: directory,
    ui: {
      custom: async () => ({ cancelled: false, comments: [{ id: "user-1", startLine: 2, endLine: 2, text: "Keep this", parentId: "agent-1" }] }),
      setEditorText(text: string) { composer = text; },
    },
    abort() { aborted = true; },
  };
  const result = await tool.execute("test", { path: "source.txt", comments: [{ startLine: 2, endLine: 2, text: "Check this" }] }, undefined, undefined, ctx);
  assert.match(composer, /Keep this/);
  assert.equal(aborted, true);
  assert.match(result.content[0].text, /staged/);
  assert.equal(await readFile(path, "utf8"), original);
});

test("aborts safely before opening UI when validation observes cancellation", async () => {
  let tool: any;
  register({ registerTool(value: unknown) { tool = value; } } as any);
  const directory = await mkdtemp(join(tmpdir(), "pi-marginalia-abort-"));
  await writeFile(join(directory, "source.txt"), "one\n", "utf8");
  const controller = new AbortController();
  const comments = { map() { controller.abort(); return []; } };
  await assert.rejects(
    () => tool.execute("test", { path: "source.txt", comments } as any, controller.signal, undefined, { mode: "tui", cwd: directory }),
    /Operation aborted/,
  );
});

test("closes the UI when the active signal aborts during review", async () => {
  let tool: any;
  register({ registerTool(value: unknown) { tool = value; } } as any);
  const directory = await mkdtemp(join(tmpdir(), "pi-marginalia-abort-ui-"));
  await writeFile(join(directory, "source.txt"), "one\n", "utf8");
  const controller = new AbortController();
  let aborted = false;
  const result = await tool.execute("test", { path: "source.txt", comments: [] }, controller.signal, undefined, {
    mode: "tui", cwd: directory,
    ui: {
      custom: async (factory: any) => new Promise((resolve) => {
        factory(makeTui(), theme, {}, resolve);
        controller.abort();
      }),
      setEditorText() {},
    },
    abort() { aborted = true; },
  });
  assert.equal(result.details.cancelled, true);
  assert.equal(aborted, true);
});

test("cancellation aborts the current turn without touching the composer", async () => {
  let tool: any;
  register({ registerTool(value: unknown) { tool = value; } } as any);
  const directory = await mkdtemp(join(tmpdir(), "pi-marginalia-cancel-"));
  await writeFile(join(directory, "source.txt"), "one\n", "utf8");
  let aborted = false;
  let composer = "unchanged";
  const result = await tool.execute("test", { path: "source.txt", comments: [] }, undefined, undefined, {
    mode: "tui", cwd: directory,
    ui: { custom: async () => ({ cancelled: true }), setEditorText(text: string) { composer = text; } },
    abort() { aborted = true; },
  });
  assert.equal(aborted, true);
  assert.equal(composer, "unchanged");
  assert.match(result.content[0].text, /cancelled/);
});

test("refuses non-TUI execution before reading the file", async () => {
  let tool: any;
  register({ registerTool(value: unknown) { tool = value; } } as any);
  await assert.rejects(
    () => tool.execute("test", { path: "missing", comments: [] }, undefined, undefined, { mode: "print", cwd: "/tmp" }),
    /requires Pi TUI mode/,
  );
});
