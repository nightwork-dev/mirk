import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeFixtureCli } from "./cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function writeConfig(
  files: Record<string, string>,
  options: { materialize?: boolean; failList?: boolean } = {}
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mirk-fixtures-cli-test-"));
  temporaryDirectories.push(directory);
  const serializedFiles = JSON.stringify(files);
  const materializer = options.materialize
    ? ", materialize: value => ({ ...value, materialized: true })"
    : "";
  const list = options.failList
    ? "() => { throw new Error('/private/fixture-secret/list failed'); }"
    : "() => Object.keys(files).map(relativePath => ({ relativePath, locator: relativePath }))";
  const source = `
const files = ${serializedFiles};
const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
const definition = { type: "theme", directory: "themes", schema${materializer} };
const registry = { get: type => type === "theme" ? definition : undefined, has: type => type === "theme", types: () => ["theme"] };
const source = { id: "memory", list: ${list}, read: entry => files[entry.relativePath] };
export default { registry, sources: [source] };
`;
  const configPath = join(directory, "mirk.fixtures.mjs");
  await writeFile(configPath, source, "utf8");
  return configPath;
}

async function writeModule(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mirk-fixtures-cli-test-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "mirk.fixtures.mjs");
  await writeFile(configPath, source, "utf8");
  return configPath;
}

describe("fixture CLI", () => {
  it("emits deterministic versioned JSON for list and show", async () => {
    const config = await writeConfig(
      {
        "themes/dark.json": JSON.stringify({ name: "dark" }),
        "themes/light.json": JSON.stringify({ name: "light" }),
      },
      { materialize: true }
    );

    const list = await executeFixtureCli(["list", config, "--json"]);
    expect(list.exitCode).toBe(0);
    expect(list.envelope).toMatchObject({
      schema: "mirk-fixtures-cli/v1",
      command: "list",
      ok: true,
    });
    expect(list.envelope.result).toEqual({
      refs: ["theme:dark", "theme:light"],
    });

    const raw = await executeFixtureCli([
      "show",
      config,
      "theme:dark",
      "--raw",
      "--json",
    ]);
    expect(raw.exitCode).toBe(0);
    expect(raw.envelope.result).toMatchObject({
      mode: "raw",
      value: { name: "dark" },
    });

    const materialized = await executeFixtureCli([
      "show",
      config,
      "theme:dark",
      "--materialized",
      "--json",
    ]);
    expect(materialized.exitCode).toBe(0);
    expect(materialized.envelope.result).toMatchObject({
      mode: "materialized",
      value: { name: "dark", materialized: true },
    });
  });

  it("supports list filtering, graph formats, and provenance explain", async () => {
    const config = await writeConfig({
      "themes/dark.json": JSON.stringify({ name: "dark" }),
    });
    const list = await executeFixtureCli(["list", config, "--type", "theme"]);
    expect(list.text).toBe("theme:dark");

    const explain = await executeFixtureCli([
      "explain",
      config,
      "theme:dark",
      "--json",
    ]);
    expect(explain.envelope.result).toMatchObject({ finalRef: "theme:dark" });

    const graph = await executeFixtureCli(["graph", config, "--format", "dot"]);
    expect(graph.exitCode).toBe(0);
    expect(graph.text).toContain('"theme:dark"');
  });

  it("redacts paths and maps source failures to exit code 3", async () => {
    const config = await writeConfig(
      { "themes/dark.json": JSON.stringify({ name: "dark" }) },
      { failList: true }
    );
    const result = await executeFixtureCli(["list", config, "--json"]);
    expect(result.exitCode).toBe(3);
    expect(result.text).not.toContain("/private/fixture-secret");
    expect(result.envelope.diagnostics[0]).toMatchObject({
      code: "source-list-failed",
    });

    const debug = await executeFixtureCli([
      "list",
      config,
      "--json",
      "--debug-paths",
    ]);
    expect(debug.text).toContain("/private/fixture-secret");
  });

  it("reports configuration and usage failures with exit code 2", async () => {
    const missing = await executeFixtureCli([
      "validate",
      "/tmp/mirk-fixtures-does-not-exist.mjs",
      "--json",
    ]);
    expect(missing.exitCode).toBe(2);
    expect(missing.envelope.diagnostics[0]).toMatchObject({
      code: "config-load-failed",
    });

    const usage = await executeFixtureCli(["list", "--unknown"]);
    expect(usage.exitCode).toBe(2);
    expect(usage.envelope.diagnostics[0]).toMatchObject({
      code: "usage-error",
    });
  });

  it("keeps validate output deterministic and aggregates every schema issue", async () => {
    const config = await writeModule(`
const files = {
  "themes/z.json": "{\\"name\\":\\"z\\"}",
  "themes/a.json": "{\\"name\\":\\"a\\"}",
};
const schema = { "~standard": {
  version: 1,
  vendor: "test",
  validate: value => ({ issues: [
    { message: "invalid name", path: ["name"] },
    { message: "invalid palette", path: ["palette"] },
  ] }),
} };
const definition = { type: "theme", directory: "themes", schema };
const registry = { get: type => type === "theme" ? definition : undefined, has: type => type === "theme", types: () => ["theme"] };
const source = { id: "memory", list: () => Object.keys(files).map(relativePath => ({ relativePath, locator: relativePath })), read: entry => files[entry.relativePath] };
export default { registry, sources: [source] };
`);

    const first = await executeFixtureCli(["validate", config, "--json"]);
    const second = await executeFixtureCli(["validate", config, "--json"]);

    expect(first.exitCode).toBe(1);
    expect(first.text).toBe(second.text);
    expect(first.envelope).toMatchObject({
      schema: "mirk-fixtures-cli/v1",
      command: "validate",
      ok: false,
    });
    expect(first.envelope.diagnostics).toHaveLength(4);
    expect(
      first.envelope.diagnostics.map((diagnostic) => [
        diagnostic.fixture,
        diagnostic.fieldPath,
      ])
    ).toEqual([
      ["theme:a", "name"],
      ["theme:a", "palette"],
      ["theme:z", "name"],
      ["theme:z", "palette"],
    ]);
    expect(first.envelope.result).toMatchObject({ ok: false });
    expect(
      (first.envelope.result as { diagnostics: unknown[] }).diagnostics
    ).toHaveLength(4);
  });

  it("emits JSON graph output with unresolved references", async () => {
    const config = await writeModule(`
const files = { "templates/welcome.json": "{\\"theme\\":{\\"$ref\\":\\"theme:missing\\"}}" };
const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
const theme = { type: "theme", directory: "themes", schema };
const template = { type: "template", directory: "templates", schema };
const registry = { get: type => type === "theme" ? theme : type === "template" ? template : undefined, has: type => type === "theme" || type === "template", types: () => ["theme", "template"] };
const source = { id: "memory", list: () => Object.keys(files).map(relativePath => ({ relativePath, locator: relativePath })), read: entry => files[entry.relativePath] };
export default { registry, sources: [source] };
`);

    const graph = await executeFixtureCli(["graph", config, "--json"]);
    expect(graph.exitCode).toBe(0);
    expect(graph.envelope.ok).toBe(true);
    expect(graph.envelope.result).toEqual({
      diagnostics: [],
      edges: [
        { from: "template:welcome", to: "theme:missing", fieldPath: ["theme"] },
      ],
      nodes: [
        {
          id: "welcome",
          ref: "template:welcome",
          resolved: true,
          type: "template",
        },
        { id: "missing", ref: "theme:missing", resolved: false, type: "theme" },
      ],
    });
  });

  it("escapes fixture refs and field paths in DOT graph output", async () => {
    const targetRef = 'theme:quoted"ref\\\\tail';
    const fieldPath = ['meta"quoted', "line\nbreak"];
    const config = await writeModule(`
const files = { "templates/item.json": "{}" };
const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
const definition = { type: "template", directory: "templates", schema, extractReferences: () => [{ ref: ${JSON.stringify(
      targetRef
    )}, fieldPath: ${JSON.stringify(fieldPath)} }] };
const registry = { get: type => type === "template" ? definition : undefined, has: type => type === "template", types: () => ["template"] };
const source = { id: "memory", list: () => Object.keys(files).map(relativePath => ({ relativePath, locator: relativePath })), read: entry => files[entry.relativePath] };
export default { registry, sources: [source] };
`);

    const graph = await executeFixtureCli(["graph", config, "--format", "dot"]);
    expect(graph.exitCode).toBe(0);
    const escapeDot = (value: string) =>
      value
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"')
        .replaceAll("\n", "\\n")
        .replaceAll("\r", "\\r");
    const escapedTarget = escapeDot(targetRef);
    const escapedFieldPath = escapeDot(fieldPath.join("."));
    expect(graph.text).toContain(
      `"${escapedTarget}" [label="${escapedTarget}", style=dashed];`
    );
    expect(graph.text).toContain(` [label="${escapedFieldPath}"];`);
  });

  it("uses parsers supplied by the configuration module", async () => {
    const config = await writeModule(`
const files = { "themes/dark.fixture": "dark" };
const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
const definition = { type: "theme", directory: "themes", extensions: [".fixture"], schema };
const registry = { get: type => type === "theme" ? definition : undefined, has: type => type === "theme", types: () => ["theme"] };
const source = { id: "memory", list: () => Object.keys(files).map(relativePath => ({ relativePath, locator: relativePath })), read: entry => files[entry.relativePath] };
const parsers = { ".fixture": content => ({ name: content.trim(), parser: "config" }) };
export default { registry, sources: [source], parsers };
`);

    const result = await executeFixtureCli([
      "show",
      config,
      "theme:dark",
      "--raw",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.envelope.result).toMatchObject({
      value: { name: "dark", parser: "config" },
    });
  });

  it("keeps source read failures distinct from source list failures", async () => {
    const config = await writeModule(`
const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
const definition = { type: "theme", directory: "themes", schema };
const registry = { get: type => type === "theme" ? definition : undefined, has: type => type === "theme", types: () => ["theme"] };
const source = {
  id: "read-broken",
  list: () => [{ relativePath: "themes/dark.json", locator: "dark" }],
  read: () => { throw new Error("/private/fixture-secret/read failed"); },
};
export default { registry, sources: [source] };
`);

    const read = await executeFixtureCli([
      "show",
      config,
      "theme:dark",
      "--raw",
      "--json",
    ]);
    expect(read.exitCode).toBe(3);
    expect(read.envelope.diagnostics[0]).toMatchObject({
      code: "source-read-failed",
      source: "read-broken",
    });
    expect(read.text).not.toContain("/private/fixture-secret");

    const list = await executeFixtureCli([
      "list",
      await writeConfig({}, { failList: true }),
      "--json",
    ]);
    expect(list.exitCode).toBe(3);
    expect(list.envelope.diagnostics[0]).toMatchObject({
      code: "source-list-failed",
    });
    expect(list.envelope.diagnostics[0]?.code).not.toBe(
      read.envelope.diagnostics[0]?.code
    );
  });

  it("uses stable exit codes for success, fixture errors, configuration, and usage", async () => {
    const validConfig = await writeConfig({
      "themes/dark.json": JSON.stringify({ name: "dark" }),
    });
    const malformedConfig = await writeConfig({
      "themes/dark.json": "not json",
    });

    await expect(
      executeFixtureCli(["list", validConfig])
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      executeFixtureCli(["show", validConfig, "theme:missing"])
    ).resolves.toMatchObject({ exitCode: 1 });
    await expect(
      executeFixtureCli(["show", malformedConfig, "theme:dark"])
    ).resolves.toMatchObject({ exitCode: 1 });
    await expect(
      executeFixtureCli(["list", "--unknown"])
    ).resolves.toMatchObject({ exitCode: 2 });
    await expect(
      executeFixtureCli([
        "validate",
        join(tmpdir(), "mirk-fixtures-no-config.mjs"),
      ])
    ).resolves.toMatchObject({ exitCode: 2 });
  });

  it("reports configuration import failures as configuration diagnostics", async () => {
    const config = await writeModule(
      'throw new Error("/private/fixture-secret/config import failed");'
    );

    const result = await executeFixtureCli(["validate", config, "--json"]);
    expect(result.exitCode).toBe(2);
    expect(result.envelope.diagnostics[0]).toMatchObject({
      code: "config-load-failed",
    });
    expect(result.text).not.toContain("/private/fixture-secret");

    const debug = await executeFixtureCli([
      "validate",
      config,
      "--json",
      "--debug-paths",
    ]);
    expect(debug.text).toContain(
      "/private/fixture-secret/config import failed"
    );
  });

  it("redacts absolute paths from usage diagnostics unless debug mode is explicit", async () => {
    const result = await executeFixtureCli([
      "/private/fixture-secret/unknown-command",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.text).not.toContain("/private/fixture-secret");
    expect(result.envelope.command).toBe("<redacted>");

    const debug = await executeFixtureCli([
      "/private/fixture-secret/unknown-command",
      "--debug-paths",
    ]);
    expect(debug.text).toContain("/private/fixture-secret/unknown-command");
    expect(debug.envelope.command).toBe(
      "/private/fixture-secret/unknown-command"
    );
  });

  it("keeps untrusted raw values JSON-safe, deterministic, and path-safe", async () => {
    const config = await writeModule(`
const files = { "themes/dark.fixture": "dark" };
const schema = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
const definition = { type: "theme", directory: "themes", extensions: [".fixture"], schema };
const registry = { get: type => type === "theme" ? definition : undefined, has: type => type === "theme", types: () => ["theme"] };
const source = { id: "memory", list: () => Object.keys(files).map(relativePath => ({ relativePath, locator: relativePath })), read: entry => files[entry.relativePath] };
const parsers = { ".fixture": () => ({
  path: "/private/fixture-secret/value",
  nested: { message: "see /private/fixture-secret/nested" },
  date: new Date("2024-01-02T03:04:05.000Z"),
  map: new Map([[2n, "/private/fixture-secret/map"], [1n, "one"]]),
  set: new Set(["z", "a"]),
}) };
export default { registry, sources: [source], parsers };
`);

    const result = await executeFixtureCli([
      "show",
      config,
      "theme:dark",
      "--raw",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.text).not.toContain("/private/fixture-secret");
    expect(result.envelope.result).toMatchObject({
      value: {
        path: "<redacted>",
        nested: { message: "see <redacted>" },
        date: "2024-01-02T03:04:05.000Z",
        map: [
          ["1n", "one"],
          ["2n", "<redacted>"],
        ],
        set: ["a", "z"],
      },
    });
  });
});
