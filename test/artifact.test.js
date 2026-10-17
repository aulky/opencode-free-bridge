const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const artifact = require("../artifact");

/**
 * A miniature tar builder so the reader is tested against real tar bytes
 * (headers, padding, zero blocks) rather than a mock of itself.
 */
function buildTar(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    // Checksum: computed with the field as spaces.
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");

    blocks.push(header, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
}

describe("artifact: tar reader", () => {
  it("reads regular files and skips the end-of-archive block", () => {
    const tar = buildTar({
      "package/package.json": '{"name":"x"}',
      "package/dist/a.js": "var a = 1;",
    });
    const entries = artifact.readTarEntries(tar);
    assert.equal(entries.size, 2);
    assert.equal(entries.get("package/dist/a.js").toString("utf8"), "var a = 1;");
  });

  it("decompresses a gzipped tarball", () => {
    const zlib = require("node:zlib");
    const tar = buildTar({ "package/x.js": "hello" });
    const gz = zlib.gzipSync(tar);
    const entries = artifact.readTarEntries(gz);
    assert.equal(entries.get("package/x.js").toString("utf8"), "hello");
  });
});

describe("artifact: literal scanning", () => {
  it("reads double-quoted, single-quoted and template literals", () => {
    assert.equal(artifact.readLiteral('"abc"', 0).value, "abc");
    assert.equal(artifact.readLiteral("'abc'", 0).value, "abc");
    assert.equal(artifact.readLiteral("`abc`", 0).value, "abc");
  });

  it("decodes escapes without mangling the rest of the string", () => {
    const lit = artifact.readLiteral('"a\\"b\\nc"', 0);
    assert.equal(lit.value, 'a"b\nc');
  });

  it("skips ${…} holes in a template and records them", () => {
    const lit = artifact.readLiteral("`a ${X} b`", 0);
    assert.equal(lit.interpolated, true);
    assert.equal(lit.holes.length, 1);
    assert.equal(lit.holes[0].expr, "X");
    assert.equal(lit.value, "a  b");
  });

  it("returns null on an unterminated literal", () => {
    assert.equal(artifact.readLiteral('"abc', 0), null);
  });
});

describe("artifact: brace matching", () => {
  it("matches nested braces", () => {
    const src = "{ a: { b: 1 } }";
    assert.equal(artifact.matchBrace(src, 0), src.length);
  });

  it("ignores braces inside strings and comments", () => {
    const src = '{ a: "}", b: "{" }';
    assert.equal(artifact.matchBrace(src, 0), src.length);
    const withComment = "{ a: 1 /* } */ }";
    assert.equal(artifact.matchBrace(withComment, 0), withComment.length);
  });
});

describe("artifact: top-level splitting", () => {
  it("splits on top-level commas only", () => {
    const body = 'a: 1, b: { c: 2, d: 3 }, e: "x,y"';
    const parts = artifact.splitTopLevel(body, 0, body.length);
    assert.equal(parts.length, 3);
    assert.equal(parts[1], "b: { c: 2, d: 3 }");
    assert.equal(parts[2], 'e: "x,y"');
  });
});

/**
 * A compiled-module fixture shaped like the real bundle: a name constant, a
 * Schema.Struct input, and an editor.add call with a literal description.
 */
const MODULE = `
import { Effect, Schema } from "effect";
var name9 = "read";
var LocationInput = Schema.Struct({
  path: Schema.String.annotate({ description: "File or directory to read" }),
  offset: PageInput2.fields.offset.annotate({
    description: "The line or directory entry to start reading from (1-based)"
  }),
  limit: Schema.optionalKey(NonNegativeInt2).annotate({
    description: "The maximum number of lines to read"
  })
});
var Input9 = LocationInput;
var Plugin46 = {
  effect: Effect.fn("ReadTool.Plugin")(function* (ctx) {
    yield* ctx.tool.transform((editor) => editor.add({
      name: name9,
      description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Use offset and limit to read large files in sections.",
      input: Input9,
      output: Output,
      execute: (input, context) => {}
    }))
  })
};
`;

const PAGE_INPUT_MODULE = `
var PageInput2 = Schema.Struct({
  offset: Schema.optionalKey(NonNegativeInt2),
  limit: Schema.optionalKey(NonNegativeInt2)
});
`;

describe("artifact: tool extraction", () => {
  it("extracts name, description, properties and required list", () => {
    const chunks = [
      { name: "a.js", text: PAGE_INPUT_MODULE },
      { name: "b.js", text: MODULE },
    ];
    const symbols = artifact.buildSymbolIndex(chunks);
    const result = artifact.extractTool(MODULE, symbols, { os: "Linux", shell: "bash" });

    assert.ok(result, "tool should be extracted");
    assert.equal(result.tool.name, "read");
    assert.match(result.tool.description, /^Read the contents of a file or directory/);
    assert.deepEqual(Object.keys(result.tool.parameters.properties), ["path", "offset", "limit"]);
    // `path` is a plain Schema.String, so it is required; the other two are
    // wrapped in optionalKey (one directly, one via PageInput2).
    assert.deepEqual(result.tool.parameters.required, ["path"]);
  });

  it("resolves a field type inherited from another chunk", () => {
    const chunks = [
      { name: "a.js", text: PAGE_INPUT_MODULE },
      { name: "b.js", text: MODULE },
    ];
    const symbols = artifact.buildSymbolIndex(chunks);
    const { tool } = artifact.extractTool(MODULE, symbols, { os: "Linux", shell: "bash" });
    const offset = tool.parameters.properties.offset;
    // NonNegativeInt2 is an integer with minimum 0.
    assert.equal(offset.type, "integer");
    assert.equal(offset.minimum, 0);
  });

  it("expands a description builder and its ${OS}/${shell} holes", () => {
    const source = `
var name6 = "shell";
var OS = process.platform === "darwin" ? "macOS" : "Linux";
var description = (shell) => [
  "Execute a shell command and return its output.",
  ...shell ? [\`Commands run on \${OS} using \${shell}.\`] : [],
  "Quote file paths containing spaces."
].join(" ");
var Input6 = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell command string to execute" })
});
var Plugin = {
  effect: Effect.fn("ShellTool.Plugin")(function* (ctx) {
    yield* ctx.tool.transform((editor) => editor.add({
      name: name6,
      description: description(),
      input: Input6
    }))
  })
};
`;
    const symbols = artifact.buildSymbolIndex([{ name: "s.js", text: source }]);
    const result = artifact.extractTool(source, symbols, { os: "Linux", shell: "bash" });
    assert.ok(result, "shell tool should be extracted");
    assert.equal(
      result.tool.description,
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces."
    );
  });

  it("returns null for a module with no editor.add", () => {
    const symbols = artifact.buildSymbolIndex([]);
    assert.equal(artifact.extractTool("var x = 1;", symbols, {}), null);
  });
});

describe("artifact: package-wide extraction", () => {
  it("maps chunks to tools via the source marker and reports missing ones", () => {
    const tar = buildTar({
      "package/dist/chunks/instance-a.js": `// src/tool/plugin/read.ts\n${PAGE_INPUT_MODULE}\n${MODULE}`,
      "package/dist/chunks/instance-b.js": "// src/tool/plugin/broken.ts\nvar nothing = 1;",
      "package/dist/chunks/instance-c.js": "// unrelated chunk\nvar x = 1;",
    });
    const entries = artifact.readTarEntries(tar);
    const { tools, missing } = artifact.extractToolsFromEntries(entries, {
      os: "Linux",
      shell: "bash",
    });
    assert.deepEqual([...tools.keys()], ["read"]);
    assert.deepEqual(missing, ["broken"]);
  });
});
