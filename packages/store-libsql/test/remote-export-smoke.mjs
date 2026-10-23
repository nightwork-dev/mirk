import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(packageRoot, "../..");

if (process.argv[2] === "client") {
  await checkClient();
} else {
  await checkServer();
}

async function checkClient() {
  const blocked = [];
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        ["@libsql/client", "@libsql/client/node", "@libsql/client/sqlite3", "libsql"].includes(specifier)
        || specifier.startsWith("libsql/")
        || /^@libsql\/(darwin|linux|win32)-/.test(specifier)
        || /(?:^|\/)libsql[^/]*\.node$/.test(specifier)
      ) {
        blocked.push(specifier);
        throw Object.assign(new Error("Native libSQL import denied: " + specifier), {
          code: "MIRK_NATIVE_LIBSQL_DENIED",
        });
      }
      return nextResolve(specifier, context);
    },
  });

  if (process.env.MIRK_LIBSQL_ROOT_CONTROL === "1") {
    await assert.rejects(async () => {
      const { LibsqlAdapter } = await import("@mirk/store-libsql");
      const local = await LibsqlAdapter.open({ url: ":memory:" });
      local.close();
    }, { code: "MIRK_NATIVE_LIBSQL_DENIED" });
    assert.ok(blocked.length > 0);
    console.log(JSON.stringify({ nativeDenialControl: "passed" }));
    return;
  }

  const { LibsqlAdapter } = await import("@mirk/store-libsql/remote");
  const { createClient } = await import("@libsql/client/web");
  const url = process.env.MIRK_LIBSQL_URL;
  const adapter = await LibsqlAdapter.open({ url, dimensions: 3 });
  try {
    await adapter.kv.set("remote", { transport: new URL(url).protocol });
    assert.deepEqual(await adapter.kv.get("remote"), { transport: new URL(url).protocol });
    await adapter.kv.put("records", { id: "a", rank: 2, kind: "primary" });
    await adapter.kv.put("records", { id: "b", rank: 1, kind: "secondary" });
    assert.equal(await adapter.kv.count("records"), 2);
    assert.deepEqual(await adapter.kv.list("records", { where: { kind: "primary" } }), [
      { id: "a", rank: 2, kind: "primary" },
    ]);
    assert.equal(await adapter.kv.remove("records", "b"), true);
    await adapter.vector.upsertMany("vectors", [
      { id: "a", vector: new Float32Array([1, 0, 0]), metadata: { kind: "primary" } },
      { id: "b", vector: new Float32Array([0, 1, 0]), metadata: { kind: "secondary" } },
    ]);
    assert.deepEqual(Array.from((await adapter.vector.get("vectors", "a")).vector), [1, 0, 0]);
    const hits = await adapter.vector.search("vectors", new Float32Array([1, 0, 0]), {
      topK: 1,
      where: { kind: "primary" },
    });
    assert.equal(hits[0].id, "a");
    assert.equal(hits[0].score, 1);
    assert.equal(await adapter.vector.remove("vectors", "b"), true);
  } finally {
    adapter.close();
  }

  const client = createClient({ url });
  try {
    const borrowed = await LibsqlAdapter.open({ url, client, dimensions: 3 });
    assert.ok(await borrowed.kv.get("remote"));
    borrowed.close();
    assert.equal((await client.execute("SELECT 1 AS value")).rows[0].value, 1);
    await assert.rejects(LibsqlAdapter.open({ url: "file:local.db", client }), /only accepts remote/);
    assert.equal(client.closed, false);
  } finally {
    client.close();
  }
  assert.deepEqual(blocked, []);
  assert.ok(!process.report.getReport().sharedObjects.some((file) => /libsql.*\.node$/.test(file)));
  console.log(JSON.stringify({ urlScheme: new URL(url).protocol, remoteFacets: "passed", nativeEngineLoaded: false }));
}

async function checkServer() {
  const binary = process.env.MIRK_LIBSQL_SERVER;
  assert.ok(binary, "Set MIRK_LIBSQL_SERVER to an isolated libSQL server executable.");
  const temporary = await mkdtemp(join(tmpdir(), "mirk-libsql-remote-"));
  let server;
  let serverLog = "";
  let serverError;
  try {
    for (const [name, source] of [["store", join(root, "packages/store")], ["store-libsql", packageRoot]]) {
      const destination = join(temporary, "node_modules/@mirk", name);
      await mkdir(destination, { recursive: true });
      const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
      await cp(join(source, "dist"), join(destination, "dist"), { recursive: true });
      await writeFile(join(destination, "package.json"), JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        type: "module",
        exports: manifest.publishConfig?.exports ?? manifest.exports,
      }));
    }
    await mkdir(join(temporary, "node_modules/@libsql"), { recursive: true });
    await symlink(await realpath(join(packageRoot, "node_modules/@libsql/client")),
      join(temporary, "node_modules/@libsql/client"), "dir");
    const script = join(temporary, "probe.mjs");
    await cp(fileURLToPath(import.meta.url), script);

    await checkDeclarations(temporary);
    const httpPort = await freePort();
    let wsPort;
    do { wsPort = await freePort(); } while (wsPort === httpPort);
    const httpUrl = "http://127.0.0.1:" + httpPort;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SQLD_")));
    server = spawn(binary, ["--db-path", join(temporary, "database"), "--http-listen-addr", "127.0.0.1:" + httpPort,
      "--hrana-listen-addr", "127.0.0.1:" + wsPort, "--no-welcome"], {
      cwd: temporary,
      env: { ...environment, RUST_LOG: "error" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.on("error", (error) => { serverError = error; });
    for (const stream of [server.stdout, server.stderr]) stream.on("data", (data) => { serverLog += data; });
    const deadline = Date.now() + 15_000;
    while (true) {
      if (serverError) throw serverError;
      if (server.exitCode !== null) throw new Error("libSQL server exited: " + serverLog);
      try {
        await fetch(httpUrl, { signal: AbortSignal.timeout(500) });
        break;
      } catch {
        if (Date.now() >= deadline) throw new Error("libSQL server did not become ready: " + serverLog);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    await runClient(script, temporary, { MIRK_LIBSQL_ROOT_CONTROL: "1" });
    for (const url of [httpUrl, "ws://127.0.0.1:" + wsPort,
      "libsql://127.0.0.1:" + httpPort + "?tls=0"]) {
      await runClient(script, temporary, { MIRK_LIBSQL_URL: url });
    }
    console.log(JSON.stringify({ packagedExports: "passed", declarations: "passed", serverVersion:
      spawnSync(binary, ["--version"], { encoding: "utf8" }).stdout.trim() }));
  } finally {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      const force = setTimeout(() => server.kill("SIGKILL"), 2_000);
      try { await exited; } finally { clearTimeout(force); }
    }
    await rm(temporary, { recursive: true, force: true });
  }
}

async function checkDeclarations(directory) {
  await mkdir(join(directory, "node_modules/@types"), { recursive: true });
  await symlink(await realpath(join(packageRoot, "node_modules/@types/node")),
    join(directory, "node_modules/@types/node"), "dir");
  const source = join(directory, "consumer.mts");
  await writeFile(source, [
    'import { LibsqlAdapter as Local } from "@mirk/store-libsql";',
    'import { LibsqlAdapter as Remote } from "@mirk/store-libsql/remote";',
    'export const openRemote = (url: string) => Remote.open({ url });',
    'export const openLocal = () => Local.open({ url: ":memory:" });',
    'export const compatible = (remote: Remote): Local => remote;',
  ].join("\n"));
  await run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), source,
    "--declaration", "--emitDeclarationOnly", "--module", "NodeNext", "--moduleResolution", "NodeNext",
    "--target", "ES2022", "--strict", "--skipLibCheck", "--outDir", join(directory, "types")], directory);
}

async function runClient(script, cwd, extra) {
  await run(process.execPath, [script, "client"], cwd, { MIRK_LIBSQL_ROOT_CONTROL: "0", ...extra });
}

async function run(command, args, cwd, extra = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { errors += data; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  let code;
  try { [code] = await once(child, "exit"); } finally { clearTimeout(timeout); }
  assert.equal(code, 0, "Subprocess failed:\n" + output + errors);
  process.stdout.write(output);
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}
