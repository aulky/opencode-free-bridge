#!/usr/bin/env node
/**
 * artifact.js — read the tool definitions the shipped CLI actually uses, from
 * the published `@opencode/core` package.
 *
 * Why not parse GitHub source?
 *
 * The TypeScript in `packages/core/src/tool/plugin/*.ts` expresses each schema
 * as an Effect `Schema.Struct(...)`. Turning that into the JSON Schema that goes
 * on the wire means re-implementing `Schema.toJsonSchemaDocument`, `$defs`
 * inlining and `allOf` flattening — a lot of surface area to get subtly wrong,
 * and a regex over TS breaks the moment a file is reformatted.
 *
 * The published package has already done that work. `@opencode/core` ships the
 * compiled bundle, where each tool module carries a `// src/tool/plugin/x.ts`
 * marker and the literal `description:` string passed to `editor.add({...})`.
 * Reading it gives us the exact bytes the released CLI sends, at a version we
 * can pin by tarball URL.
 *
 * Size: ~1.3 MB compressed. Downloaded once per version and cached on disk, so
 * steady state costs nothing.
 *
 * Extraction is deliberately conservative: anything that does not parse is
 * reported as missing rather than guessed at. A tool we cannot read keeps the
 * previous value, and `missingFields` in /health says so.
 *
 * Known limit: this is a *static* reading of a minified bundle. Where the CLI
 * computes a value at runtime (a description built by a function, a field
 * inherited from a shared struct), the resolver follows the reference. Where it
 * genuinely cannot — a value that depends on the host machine — the result is
 * flagged, not invented. `capture.js` exists precisely to replace this guess
 * with the real bytes when a CLI is available.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

const REGISTRY = process.env.NPM_REGISTRY || "https://registry.npmjs.org";
const PACKAGE = "@opencode/core";
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.ARTIFACT_TIMEOUT_MS || "60000", 10);
const MAX_TARBALL_BYTES = parseInt(
  process.env.ARTIFACT_MAX_BYTES || String(64 * 1024 * 1024),
  10
);

function cacheDir() {
  return (
    process.env.OPENCODE_BRIDGE_CACHE ||
    path.join(os.homedir(), ".opencode-free-bridge", "cache")
  );
}

function versionDir(version) {
  const safe = String(version || "unknown").replace(/[^0-9A-Za-z._-]/g, "_");
  return path.join(cacheDir(), `core-${safe}`);
}

// ------------------------------------------------------------------ tar ---

/**
 * Minimal tar reader. The npm tarball is a gzipped ustar archive, so a full tar
 * implementation (symlinks, sparse files, PAX extended headers) is unnecessary
 * and would be a liability. Only regular files are returned; anything else is
 * skipped, which is what we want — we read `.js` text, nothing else.
 */
function readTarEntries(buffer) {
  const archive =
    buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
      ? zlib.gunzipSync(buffer)
      : buffer;
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const nameRaw = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeRaw = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/\0.*$/, "")
      .trim();
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");

    const size = parseInt(sizeRaw, 8);
    if (!Number.isFinite(size) || size < 0) break;

    const name = prefix ? `${prefix}/${nameRaw}` : nameRaw;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if ((typeFlag === "0" || typeFlag === "\0") && dataEnd <= archive.length) {
      entries.set(name, archive.subarray(dataStart, dataEnd));
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// ---------------------------------------------------------- JS scanning ---

/**
 * Read a JS string literal starting at `start`. Handles "…", '…' and `…`,
 * including `${…}` interpolation (which is skipped and flagged).
 */
function readLiteral(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const isTemplate = quote === "`";
  let i = start + 1;
  let value = "";
  let interpolated = false;
  const holes = [];

  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === "n") value += "\n";
      else if (next === "t") value += "\t";
      else if (next === "r") value += "\r";
      else if (next === quote) value += quote;
      else if (next === "\\") value += "\\";
      else if (next === "u") {
        const hex = source.slice(i + 2, i + 6);
        const code = parseInt(hex, 16);
        if (Number.isFinite(code)) {
          value += String.fromCharCode(code);
          i += 4;
        }
      } else value += next;
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1, template: isTemplate, interpolated, holes };
    if (isTemplate && ch === "$" && source[i + 1] === "{") {
      interpolated = true;
      const exprStart = i + 2;
      let depth = 1;
      i = exprStart;
      while (i < source.length && depth > 0) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") depth--;
        i++;
      }
      holes.push({ expr: source.slice(exprStart, i - 1).trim(), at: value.length });
      continue;
    }
    value += ch;
    i++;
  }
  return null;
}

function skipTrivia(source, i) {
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

/**
 * From an opening `{` (or `[` / `(`), return the index just past its match.
 * String- and comment-aware so braces inside descriptions never unbalance it.
 */
function matchBrace(source, start) {
  const open = source[start];
  if (open !== "{" && open !== "[" && open !== "(") return -1;
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const lit = readLiteral(source, i);
      if (!lit) return -1;
      i = lit.end;
      continue;
    }
    if (ch === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      i = skipTrivia(source, i);
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

/** Split the interior of an object/array at top-level commas. */
function splitTopLevel(source, start, end) {
  const parts = [];
  let depth = 0;
  let partStart = start;
  let i = start;
  while (i < end) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const lit = readLiteral(source, i);
      if (!lit) break;
      i = lit.end;
      continue;
    }
    if (ch === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
      i = skipTrivia(source, i);
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(source.slice(partStart, i));
      partStart = i + 1;
    }
    i++;
  }
  const tail = source.slice(partStart, end).trim();
  if (tail) parts.push(tail);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Find `description: <literal>` inside an expression. */
function findDescription(expr) {
  const re = /\bdescription\s*:\s*/g;
  let m;
  while ((m = re.exec(expr)) !== null) {
    const valueStart = skipTrivia(expr, m.index + m[0].length);
    const lit = readLiteral(expr, valueStart);
    if (lit) return lit;
  }
  return null;
}

// ------------------------------------------------------- symbol index ---

/**
 * Index every top-level `var X = …` in every JS chunk, so cross-file references
 * (`PageInput2.fields.offset`, `${DEFAULT_TIMEOUT_MS2}`) can be resolved.
 *
 * Three shapes matter:
 *   struct  `var X = Schema.Struct({ … })`
 *   const   `var X = <numeric/simple expression>`
 *   parts   `var X = (arg) => [ "…", … ]`  (a description builder)
 */
function buildSymbolIndex(chunks) {
  const index = new Map();
  const decl = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;

  for (const { name: chunkName, text } of chunks) {
    let m;
    decl.lastIndex = 0;
    while ((m = decl.exec(text)) !== null) {
      const symbol = m[1];
      const valueStart = skipTrivia(text, m.index + m[0].length);

      // Schema.Struct({ … })
      if (text.startsWith("Schema.Struct(", valueStart)) {
        const braceStart = text.indexOf("{", valueStart);
        const braceEnd = matchBrace(text, braceStart);
        if (braceEnd !== -1) {
          index.set(symbol, {
            kind: "struct",
            body: text.slice(braceStart + 1, braceEnd - 1),
            chunk: chunkName,
          });
          continue;
        }
      }

      // (arg) => [ … ]  or  (arg) => "…"
      const fn = text.slice(valueStart).match(/^\([^)]*\)\s*=>\s*/);
      if (fn) {
        const bodyStart = valueStart + fn[0].length;
        if (text[bodyStart] === "[") {
          const arrEnd = matchBrace(text, bodyStart);
          if (arrEnd !== -1) {
            index.set(symbol, {
              kind: "parts",
              body: text.slice(bodyStart + 1, arrEnd - 1),
              chunk: chunkName,
            });
            continue;
          }
        }
        const lit = readLiteral(text, bodyStart);
        if (lit) {
          index.set(symbol, { kind: "const", value: lit.value, chunk: chunkName });
          continue;
        }
      }

      // Plain literal / numeric expression.
      const lit = readLiteral(text, valueStart);
      if (lit) {
        index.set(symbol, { kind: "const", value: lit.value, chunk: chunkName });
        continue;
      }
      const exprMatch = text
        .slice(valueStart)
        .match(/^([\d\s*+\-/().]+?)\s*(?:;|\n)/);
      if (exprMatch) {
        index.set(symbol, { kind: "expr", expr: exprMatch[1].trim(), chunk: chunkName });
        continue;
      }

      // Alias: `var Input9 = LocationInput;`
      const aliasMatch = text
        .slice(valueStart)
        .match(/^([A-Za-z_$][\w$]*)\s*;/);
      if (aliasMatch) {
        index.set(symbol, { kind: "alias", target: aliasMatch[1], chunk: chunkName });
      }
    }
  }
  return index;
}

/** Evaluate a simple arithmetic expression (constants only). */
function evalConstExpr(expr) {
  if (!/^[\d\s*+\-/().]+$/.test(expr)) return null;
  try {
    // No identifiers can appear: the guard above rejects them.
    const value = Function(`"use strict";return (${expr})`)();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a `${…}` hole to a string, or null when it depends on runtime state.
 *
 * `OS` and `shell` are the two host-dependent values the CLI's own description
 * builder interpolates. The bridge is describing what a Linux CLI sends, which
 * is the platform the free-tier gate was calibrated on and the platform this
 * bridge runs on.
 */
function resolveHole(expr, symbols, hostContext) {
  const trimmed = expr.trim();
  if (trimmed === "OS") return hostContext.os;
  if (trimmed === "shell") return hostContext.shell;

  const sym = symbols.get(trimmed);
  if (sym && sym.kind === "const") return sym.value;
  if (sym && sym.kind === "expr") {
    const n = evalConstExpr(sym.expr);
    if (n !== null) return String(n);
  }
  return null;
}

/** Expand a template literal, substituting resolvable holes. */
function expandLiteral(lit, symbols, hostContext) {
  if (!lit.interpolated) return lit.value;
  let out = "";
  let cursor = 0;
  for (const hole of lit.holes) {
    out += lit.value.slice(cursor, hole.at);
    const resolved = resolveHole(hole.expr, symbols, hostContext);
    if (resolved === null) return null; // depends on runtime state
    out += resolved;
    cursor = hole.at;
  }
  out += lit.value.slice(cursor);
  return out;
}

/**
 * Evaluate a description builder `(shell) => [ "a", ...cond ? ["b"] : [], "c" ]`
 * by concatenating its parts with the host context applied.
 *
 * The spread entry is the only conditional form upstream uses, and it expands
 * to a single template when `shell` is truthy — which it always is for a real
 * CLI (a shell is always selected).
 */
function evalParts(body, symbols, hostContext) {
  const entries = splitTopLevel(body, 0, body.length);
  const out = [];
  for (const entry of entries) {
    // `...shell ? [ `…` ] : []`  → include when the guard is truthy.
    const spread = entry.match(/^\.\.\.\s*([A-Za-z_$][\w$]*)\s*\?\s*\[([\s\S]*)\]\s*:\s*\[\s*\]$/);
    if (spread) {
      const guard = spread[1];
      const truthy = guard === "shell" ? Boolean(hostContext.shell) : null;
      if (truthy === null) return null;
      if (truthy) {
        const inner = evalParts(spread[2], symbols, hostContext);
        if (inner === null) return null;
        out.push(inner);
      }
      continue;
    }
    const lit = readLiteral(entry, skipTrivia(entry, 0));
    if (!lit) return null;
    const expanded = expandLiteral(lit, symbols, hostContext);
    if (expanded === null) return null;
    out.push(expanded);
  }
  return out.join(" ");
}

// ------------------------------------------------------- tool extraction ---

function extractToolName(source) {
  const m = source.match(/(?:var|let|const)\s+name\w*\s*=\s*"([a-z][a-z0-9_-]{1,30})"/i);
  return m ? m[1] : null;
}

/**
 * Locate the `Schema.Struct({...})` a tool passes as `input:`.
 * Resolves aliases (`var Input9 = LocationInput;`) through the symbol index,
 * which is built from every chunk — the target often lives in another file.
 */
function findInputStruct(source, symbols) {
  const addIdx = source.search(/\.add\(\s*\{/);
  if (addIdx === -1) return null;
  const braceStart = source.indexOf("{", addIdx);
  const braceEnd = matchBrace(source, braceStart);
  if (braceEnd === -1) return null;

  const body = source.slice(braceStart + 1, braceEnd - 1);
  const m = body.match(/\binput\s*:\s*([A-Za-z_$][\w$]*)/);
  if (!m) return null;

  const seen = new Set();
  let name = m[1];
  while (name && !seen.has(name)) {
    seen.add(name);
    const sym = symbols.get(name);
    if (!sym) return null;
    if (sym.kind === "struct") return { name, ...sym };
    if (sym.kind === "alias") {
      name = sym.target;
      continue;
    }
    return null;
  }
  return null;
}

function inferJsonType(expr) {
  if (/Boolean/.test(expr)) return "boolean";
  if (/NonNegativeInt|PositiveInt|Schema\.Int|Schema\.Number|Float/.test(expr)) return "integer";
  if (/Array|List|Tuple|NonEmptyArray/.test(expr)) return "array";
  if (/Record|Struct|Object/.test(expr)) return "object";
  if (/String|Path|Literal|isStartingWith/.test(expr)) return "string";
  return null;
}

function inferMinimum(expr) {
  if (/NonNegativeInt/.test(expr)) return 0;
  if (/PositiveInt/.test(expr)) return 1;
  return null;
}

/**
 * Determine whether a field is optional.
 *
 * Two forms exist in the bundle:
 *   `key: Schema.optionalKey(X)`            — explicit
 *   `key: Shared.fields.key.annotate({…})`  — inherited from another struct
 * The second must be looked up in the symbol index, or every inherited field is
 * wrongly reported as required (which is what made `read.offset` required).
 */
function isOptional(expr, symbols) {
  if (/^Schema\.optionalKey\(/.test(expr)) return { optional: true, resolved: true };

  const ref = expr.match(/^([A-Za-z_$][\w$]*)\.fields\.([A-Za-z_$][\w$]*)/);
  if (ref) {
    const sym = symbols.get(ref[1]);
    if (sym && sym.kind === "struct") {
      const entries = splitTopLevel(sym.body, 0, sym.body.length);
      for (const entry of entries) {
        const m = entry.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/);
        if (m && m[1] === ref[2]) {
          return { optional: /^Schema\.optionalKey\(/.test(m[2].trim()), resolved: true };
        }
      }
    }
    // Reference found but target unresolved: assume optional (the safer
    // direction — a spurious `required` entry fails validation, a missing one
    // only relaxes it).
    return { optional: true, resolved: false };
  }
  return { optional: false, resolved: true };
}

/**
 * Resolve an inherited field reference like `PageInput2.fields.offset`.
 * Returns the source entry text, or null.
 */
function resolveFieldRef(expr, symbols) {
  const ref = expr.match(/^([A-Za-z_$][\w$]*)\.fields\.([A-Za-z_$][\w$]*)/);
  if (!ref) return null;
  const sym = symbols.get(ref[1]);
  if (!sym || sym.kind !== "struct") return null;
  for (const entry of splitTopLevel(sym.body, 0, sym.body.length)) {
    const m = entry.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/);
    if (m && m[1] === ref[2]) return m[2].trim();
  }
  return null;
}

function parseFieldEntry(entry, symbols, hostContext) {
  const keyMatch = entry.match(
    /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/
  );
  if (!keyMatch) return null;
  let key = keyMatch[1];
  if (key[0] === '"' || key[0] === "'") key = key.slice(1, -1);
  const expr = keyMatch[2].trim();

  // A field inherited from a shared struct (`PageInput2.fields.offset`) carries
  // its type there, not here. Resolve the source entry and merge: the local
  // `.annotate({description})` overrides the description, the source supplies
  // the type and the optionality.
  const inherited = resolveFieldRef(expr, symbols);
  const schemaExpr = inherited || expr;

  const { optional, resolved } = isOptional(expr, symbols);
  const desc = findDescription(expr) || (inherited ? findDescription(inherited) : null);
  const jsonType = inferJsonType(schemaExpr);
  const minimum = inferMinimum(schemaExpr);

  const prop = {};
  if (jsonType) prop.type = jsonType;
  if (minimum !== null) prop.minimum = minimum;
  if (desc) {
    const expanded = expandLiteral(desc, symbols, hostContext);
    if (expanded !== null) prop.description = expanded;
  }

  return { key, optional, prop, resolved: resolved && (inherited !== null || !/\.fields\./.test(expr)) };
}

/**
 * Build a JSON Schema for one tool module.
 * Returns { tool, unresolved } or null.
 */
function extractTool(source, symbols, hostContext) {
  const name = extractToolName(source);
  if (!name) return null;

  const addIdx = source.search(/\.add\(\s*\{/);
  if (addIdx === -1) return null;
  const addBrace = source.indexOf("{", addIdx);
  const addEnd = matchBrace(source, addBrace);
  if (addEnd === -1) return null;
  const addBody = source.slice(addBrace + 1, addEnd - 1);

  // Description may be a literal or a call to a builder in the same module.
  let description = null;
  const unresolved = [];

  const descLit = findDescription(addBody);
  if (descLit) {
    description = expandLiteral(descLit, symbols, hostContext);
  } else {
    const call = addBody.match(/\bdescription\s*:\s*([A-Za-z_$][\w$]*)\s*\(/);
    if (call) {
      const builder = symbols.get(call[1]);
      if (builder && builder.kind === "parts") {
        description = evalParts(builder.body, symbols, hostContext);
      }
      if (description === null) unresolved.push(`description:${call[1]}`);
    }
  }
  if (!description || description.length < 20) return null;

  const struct = findInputStruct(source, symbols);
  if (!struct) return null;

  const entries = splitTopLevel(struct.body, 0, struct.body.length);
  const properties = {};
  const required = [];

  for (const entry of entries) {
    if (entry.startsWith("...")) {
      // Spread of another struct's fields: merge it in when resolvable.
      const ref = entry.slice(3).trim().replace(/\.fields$/, "");
      const sym = symbols.get(ref);
      if (sym && sym.kind === "struct") {
        for (const inner of splitTopLevel(sym.body, 0, sym.body.length)) {
          const parsed = parseFieldEntry(inner, symbols, hostContext);
          if (!parsed) continue;
          properties[parsed.key] = parsed.prop;
          if (!parsed.optional) required.push(parsed.key);
        }
      } else {
        unresolved.push(`spread:${ref}`);
      }
      continue;
    }
    const parsed = parseFieldEntry(entry, symbols, hostContext);
    if (!parsed) continue;
    properties[parsed.key] = parsed.prop;
    if (!parsed.optional) required.push(parsed.key);
    if (!parsed.resolved) unresolved.push(`optional:${parsed.key}`);
  }

  return {
    tool: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
    unresolved,
  };
}

/**
 * Find tool modules inside the package and resolve them against a shared symbol
 * index built from every chunk (schemas are split across files by the bundler).
 */
function extractToolsFromEntries(entries, hostContext = { os: "Linux", shell: "bash" }) {
  const chunks = [];
  for (const [name, data] of entries) {
    if (/\.js$/.test(name)) chunks.push({ name, text: data.toString("utf8") });
  }

  const symbols = buildSymbolIndex(chunks);
  const tools = new Map();
  const missing = [];
  const partial = [];

  for (const chunk of chunks) {
    const marker = chunk.text.match(/\/\/ src\/tool\/plugin\/([a-z0-9-]+)\.ts/);
    if (!marker) continue;

    const result = extractTool(chunk.text, symbols, hostContext);
    if (result) {
      tools.set(result.tool.name, result.tool);
      if (result.unresolved.length > 0) {
        partial.push({ tool: result.tool.name, unresolved: result.unresolved });
      }
    } else {
      missing.push(marker[1]);
    }
  }

  return { tools, missing, partial };
}

// --------------------------------------------------------------- loading ---

async function downloadTarball(version) {
  const metaRes = await fetch(`${REGISTRY}/${PACKAGE.replace("/", "%2F")}/${version}`, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!metaRes.ok) throw new Error(`registry metadata HTTP ${metaRes.status}`);
  const meta = await metaRes.json();
  const tarballUrl = meta.dist && meta.dist.tarball;
  if (!tarballUrl) throw new Error("registry metadata has no tarball URL");

  const res = await fetch(tarballUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`tarball HTTP ${res.status}`);
  const declared = parseInt(res.headers.get("content-length") || "", 10);
  if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
    throw new Error(`tarball too large: ${declared} bytes`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_TARBALL_BYTES) throw new Error(`tarball too large: ${buf.length} bytes`);
  return { buffer: buf, integrity: (meta.dist && meta.dist.integrity) || null };
}

/**
 * Ensure the package for `version` is on disk, extracting it once.
 */
async function load(version, hostContext) {
  const dir = versionDir(version);
  const manifestPath = path.join(dir, "manifest.json");

  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.version === version && manifest.tools) {
        return { ...manifest, cached: true };
      }
    } catch {
      // Corrupt cache: fall through and re-download.
    }
  }

  const { buffer, integrity } = await downloadTarball(version);
  const entries = readTarEntries(buffer);
  const { tools, missing, partial } = extractToolsFromEntries(entries, hostContext);

  const profile = {
    version,
    integrity,
    fetchedAt: Date.now(),
    tools: Object.fromEntries(tools),
    toolNames: [...tools.keys()],
    missing,
    partial,
    bytes: buffer.length,
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(profile, null, 2));
  } catch (err) {
    profile.cacheError = err.message;
  }

  return { ...profile, cached: false };
}

function getState() {
  return { cacheDir: cacheDir(), package: PACKAGE };
}

function __clearCache(version) {
  const dir = version ? versionDir(version) : cacheDir();
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  PACKAGE,
  cacheDir,
  versionDir,
  readTarEntries,
  readLiteral,
  skipTrivia,
  matchBrace,
  splitTopLevel,
  findDescription,
  buildSymbolIndex,
  evalConstExpr,
  expandLiteral,
  evalParts,
  extractToolName,
  findInputStruct,
  isOptional,
  resolveFieldRef,
  parseFieldEntry,
  extractTool,
  extractToolsFromEntries,
  load,
  getState,
  __clearCache,
};
