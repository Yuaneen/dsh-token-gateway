/**
 * Packaging gate: prove that the artifact `npm publish` would upload is the same
 * program the tests exercise.
 *
 * `npm test` runs the working tree. Everything that breaks only *after* packing
 * stays invisible to it: a runtime file missing from `files`, a `main` or
 * `dsh.bundle.patch` path that points outside the tarball, a bundle patch whose
 * inserted row name drifted from the package name, a stray `test/` or
 * `.dsh-test/` directory in the published payload.
 *
 * So this script packs the package, reads the tarball back with a small tar
 * reader (no dependencies, matching the rest of the repo), and then *imports the
 * extracted copy* and drives a full admission -> meter -> snapshot cycle against
 * a fake host. If the shipped files cannot do that, this fails.
 *
 * Usage: node scripts/verify-pack.mjs [--keep]
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const KEEP = process.argv.includes('--keep');

const checks = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/* ------------------------------------------------------------------ tar ---- */

function cstr(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

/** Read a gzipped ustar archive into `[{path, body}]`. Directories are skipped. */
function readTarGz(buffer) {
  const tar = gunzipSync(buffer);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = cstr(header, 0, 100);
    const size = Number.parseInt(cstr(header, 124, 12).trim() || '0', 8);
    const typeflag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156]);
    const prefix = cstr(header, 345, 155);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const bodyStart = offset + 512;
    if (path !== '' && (typeflag === '0' || typeflag === '7')) {
      entries.push({ path, body: tar.subarray(bodyStart, bodyStart + size) });
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/* -------------------------------------------------------------- npm pack --- */

/** npm's CLI entry, so we never need a shell (and never a .cmd shim). */
function npmCli() {
  const candidates = [];
  if (process.env.npm_execpath !== undefined && process.env.npm_execpath.endsWith('npm-cli.js')) {
    candidates.push(process.env.npm_execpath);
  }
  candidates.push(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir !== '') candidates.push(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  return candidates.find((path) => existsSync(path));
}

function pack(destination) {
  const cli = npmCli();
  expect(cli !== undefined, 'cannot locate npm-cli.js to run `npm pack`');
  const result = spawnSync(process.execPath, [cli, 'pack', '--json', '--pack-destination', destination], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  expect(result.status === 0, `npm pack failed (exit ${result.status}): ${(result.stderr ?? '').trim()}`);
  const [report] = JSON.parse(result.stdout);
  return report;
}

/* ------------------------------------------------------------- workspace --- */

function walkWorkspace(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkWorkspace(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/* ---------------------------------------------------------------- main ----- */

const staging = mkdtempSync(join(tmpdir(), 'dsh-token-gateway-pack-'));

try {
  const report = pack(staging);
  const tarball = join(staging, report.filename);
  const entries = readTarGz(readFileSync(tarball));
  const shipped = new Map(entries.map((entry) => [entry.path.replace(/^package\//, ''), entry]));
  const shippedPaths = [...shipped.keys()];
  const workspacePkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  const read = (path) => {
    const entry = shipped.get(path);
    expect(entry !== undefined, `${path} is missing from the tarball`);
    return entry.body;
  };
  const readText = (path) => read(path).toString('utf8').replace(/\r\n/g, '\n');

  /* --- payload shape ------------------------------------------------------ */

  await check('tarball ships the plugin patch layer', () => {
    readText('cordis.patch.yml');
    return 'cordis.patch.yml';
  });

  await check('no development-only files leak into the payload', () => {
    const forbidden = [
      [/^test\//, 'test/'],
      [/^\.dsh-test\//, '.dsh-test/'],
      [/^scripts\//, 'scripts/'],
      [/^node_modules\//, 'node_modules/'],
      [/^package-lock\.json$/, 'package-lock.json'],
      [/\.tgz$/, 'a tarball'],
      [/^\.git/, '.git metadata'],
      // npm always includes README*, so a README.md.bak would ship unless caught here.
      [/^README(?!\.md$)/, 'a README backup'],
    ];
    const found = shippedPaths.filter((path) => forbidden.some(([pattern]) => pattern.test(path)));
    expect(found.length === 0, `unexpected files in the tarball: ${found.join(', ')}`);
    return `${shippedPaths.length} files, all publishable`;
  });

  await check('every shipped src module is present', () => {
    const expected = walkWorkspace(join(ROOT, 'src')).map((path) => `src/${path}`);
    const missing = expected.filter((path) => !shipped.has(path));
    expect(missing.length === 0, `src modules missing from the tarball: ${missing.join(', ')}`);
    return `${expected.length} modules`;
  });

  await check('shipped bytes match the working tree', () => {
    const drifted = shippedPaths
      .filter((path) => existsSync(join(ROOT, path)))
      .filter((path) => !readFileSync(join(ROOT, path)).equals(read(path)));
    expect(drifted.length === 0, `packed content differs from the working tree: ${drifted.join(', ')}`);
    return `${shippedPaths.length} files byte-identical`;
  });

  /* --- package metadata --------------------------------------------------- */

  await check('package metadata points inside the tarball', () => {
    const pkg = JSON.parse(readText('package.json'));
    expect(pkg.name === workspacePkg.name, `name ${pkg.name} != ${workspacePkg.name}`);
    expect(pkg.version === workspacePkg.version, `version ${pkg.version} != ${workspacePkg.version}`);
    expect(pkg.type === 'module', 'type must be "module"');
    for (const [label, target] of [
      ['main', pkg.main],
      ['exports["."]', pkg.exports?.['.']],
      ['exports["./client"]', pkg.exports?.['./client']],
      ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
    ]) {
      expect(typeof target === 'string', `${label} is not a path`);
      const path = target.replace(/^\.\//, '');
      expect(shipped.has(path), `${label} -> ${target} is not in the tarball`);
    }
    expect(pkg.engines?.node !== undefined, 'engines.node is missing');
    expect(pkg.engines?.dsh !== undefined, 'engines.dsh is missing');
    return `main=${pkg.main} patch=${pkg.dsh.bundle.patch}`;
  });

  /* --- the loader row the profile will get -------------------------------- */

  await check('bundle patch inserts exactly one row named after the package', () => {
    const patch = readText('cordis.patch.yml');
    expect(/^- insert:/m.test(patch), 'cordis.patch.yml has no top-level `- insert:` list');
    const rows = [...patch.matchAll(/^\s+-\s+id:\s*(\S+)\s*$/gm)];
    expect(rows.length === 1, `expected exactly 1 inserted row, found ${rows.length}`);
    const names = [...patch.matchAll(/^\s+name:\s*["']?([^"'\s#]+)["']?\s*$/gm)].map((match) => match[1]);
    expect(names.length === 1, `expected exactly 1 row name, found ${names.length}`);
    expect(
      names[0] === workspacePkg.name,
      `row name "${names[0]}" must equal the package name "${workspacePkg.name}", or the loader cannot resolve it`,
    );
    expect(/budgets:\s*\n(?:\s+\w+:.*\n)+/m.test(patch), 'the inserted row has no budgets block');
    return `id=${rows[0][1]} name=${names[0]}`;
  });

  /* --- the browser artifact ----------------------------------------------- */

  await check('the client artifact is a loadable module-table factory', () => {
    const pkg = JSON.parse(readText('package.json'));
    const clientPath = String(pkg.exports?.['./client'] ?? '').replace(/^\.\//, '');
    expect(clientPath !== '', 'exports["./client"] is not a path');
    const source = readText(clientPath);

    // The loader keys the factory by id and shares React through the module
    // table; a wrong id or a bundled React copy breaks the page, not the host.
    expect(source.includes('window.__ModuleLoader__.load('), 'client artifact never registers with window.__ModuleLoader__');
    const escaped = pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(
      new RegExp(`id:\\s*['"]${escaped}['"]`).test(source),
      `client factory id must equal the package name "${pkg.name}"`,
    );
    expect(source.includes('factory(require)'), 'client artifact exports no factory(require)');
    expect(source.includes("require('react')"), 'client artifact must take React from the module table');
    expect(/^\s*import\s/m.test(source) === false, 'client artifact must be CJS, not ESM');
    expect(/require\(\s*['"]\.\//.test(source) === false, 'client artifact must be self-contained (no relative requires)');
    expect(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be "web"');
    expect(
      Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0,
      'dsh.client.inject must name the plugin that owns the target slot',
    );
    return `${clientPath} -> factory id ${pkg.name}, slot owner ${pkg.dsh.client.inject.join(', ')}`;
  });

  /* --- host compatibility (advisory) -------------------------------------- */

  await check('engines are compatible with this host (advisory)', () => {
    const runtime = join(process.env.DSH_HOME ?? join(tmpdir(), 'missing'), 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json');
    const pkg = JSON.parse(readText('package.json'));
    const nodeOk = process.versions.node.localeCompare('22.19.0', undefined, { numeric: true }) >= 0;
    expect(nodeOk, `node ${process.versions.node} is below engines.node ${pkg.engines.node}`);
    if (!existsSync(runtime)) return `node ${process.versions.node} ok; host version unknown`;
    const host = JSON.parse(readFileSync(runtime, 'utf8'));
    return `node ${process.versions.node} ok; host dsh ${host.desktopVersion} vs engines.dsh ${pkg.engines.dsh}`;
  });

  /* --- the shipped program actually runs ---------------------------------- */

  const unpacked = join(staging, 'package');
  for (const [path, entry] of shipped) {
    const target = join(unpacked, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.body);
  }

  await check('the extracted package imports and meters a call end to end', async () => {
    const pkg = JSON.parse(readText('package.json'));
    const module = await import(pathToFileURL(join(unpacked, pkg.main)).href);

    expect(module.name === 'token-gateway', `name export is ${module.name}`);
    expect(Array.isArray(module.inject) && module.inject.includes('llm'), 'inject must declare the llm service');
    expect(typeof module.apply === 'function', 'apply is not exported');

    const listeners = new Map();
    const commands = [];
    const routes = [];
    const ctx = {
      logger: () => ({ info() {}, warn() {} }),
      llm: { stream: () => (async function* () {})() },
      on: (name, handler, options) => listeners.set(name, { handler, options }),
      get: (name) => {
        if (name === 'commands') return { register: (definition) => (commands.push(definition), () => {}) };
        if (name === 'webServer') return { register: (route) => (routes.push(route), () => {}) };
        return undefined;
      },
      effect: (fn) => void fn(),
    };

    await module.apply(ctx, { persistence: { enabled: false }, budgets: { session: 1, daily: 5, monthly: 20 } });

    expect(listeners.has('llm/stream'), 'llm/stream was not registered');
    expect(listeners.get('llm/stream').options?.prepend === true, 'llm/stream must be prepended');
    expect(commands[0]?.name === 'gateway', '/gateway command was not registered');
    expect(routes[0]?.kind === 'prefix', 'control API was not registered as a prefix route');

    const stream = listeners.get('llm/stream').handler(
      { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 'verify' },
      () =>
        (async function* upstream() {
          yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })(),
    );
    let chunks = 0;
    for await (const chunk of stream) chunks += 1;
    expect(chunks === 2, `metered stream forwarded ${chunks} chunks, expected 2`);

    const response = { status: 0, body: '', writeHead(status) { this.status = status; }, end(body) { this.body = String(body); } };
    await routes[0].handler(
      { method: 'GET', url: '/token-gateway/v1/status?session=verify', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      response,
    );
    const body = JSON.parse(response.body);
    expect(response.status === 200, `status route returned ${response.status}`);
    expect(body.data.totals.session > 0, `shipped build metered ${body.data.totals.session} USD for one call`);
    expect(body.data.models[0]?.tokens === 1500, `token attribution is ${body.data.models[0]?.tokens}, expected 1500`);

    return `metered $${body.data.totals.session.toFixed(6)} / 1500 tokens from the packed artifact`;
  });

  /* --- report ------------------------------------------------------------- */

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const entry of checks) {
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name.padEnd(width)}  ${entry.detail}`);
  }
  const failed = checks.filter((entry) => !entry.ok);
  console.log('');
  console.log(`tarball: ${report.filename}  ${(report.size / 1024).toFixed(1)} KiB packed / ${(report.unpackedSize / 1024).toFixed(1)} KiB unpacked  ${shippedPaths.length} files`);
  console.log(`${checks.length - failed.length}/${checks.length} packaging checks passed`);
  if (failed.length > 0) process.exitCode = 1;
} finally {
  if (KEEP) console.log(`kept: ${staging}`);
  else rmSync(staging, { recursive: true, force: true });
}
