import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const requireFromRoot = createRequire(import.meta.url);

test('Dockerfile matches package runtime and only copies existing paths', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM node:24-alpine/m);
  assert.doesNotMatch(dockerfile, /pricing-litellm|pricing-openrouter/);
  assert.match(dockerfile, /^COPY public \.\/public$/m);
  assert.match(dockerfile, /^COPY data\/\.gitkeep \.\/data\/\.gitkeep$/m);
  assert.match(dockerfile, /^COPY data\/official-pricing\.json \.\/data\/official-pricing\.json$/m);
  assert.match(dockerfile, /^COPY scripts\/build-runtime\.ts \.\/scripts\/build-runtime\.ts$/m);
  assert.match(dockerfile, /npm run build && node scripts\/build-runtime\.ts && npm prune --omit=dev/);
  assert.match(dockerfile, /^CMD \["node", "dist-runtime\/server\.mjs"\]$/m);
  assert.doesNotMatch(dockerfile, /^CMD \["node", "src\/server\.ts"\]$/m);

  for (const match of dockerfile.matchAll(/^COPY\s+(.+?)\s+(.+)$/gm)) {
    const sources = match[1].split(/\s+/).filter(item => item !== '--from');
    for (const source of sources) {
      if (source.startsWith('--')) continue;
      assert.equal(existsSync(resolve(root, source)), true, `Dockerfile COPY source must exist: ${source}`);
    }
  }
});

test('production server serves every first-party SPA route', () => {
  const source = readFileSync(resolve(root, 'src', 'server.ts'), 'utf8');
  assert.match(source, /SPA_ROUTES\s*=\s*new Set\(\['\/', '\/review', '\/live', '\/trust'\]\)/);
  assert.match(source, /SPA_ROUTES\.has\(pathname\)/);
});

test('runtime package build does not emit declaration files as modules', () => {
  const result = spawnSync(process.execPath, ['scripts/build-runtime.ts'], {
    cwd: root,
    encoding: 'utf8'
  });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(readFileSync(resolve(root, 'dist-runtime', 'cli.mjs'), 'utf8'), /^#!\/usr\/bin\/env node/);
    assert.doesNotMatch(readFileSync(resolve(root, 'dist-runtime', 'collector-registry.mjs'), 'utf8'), /\.\/collectors\/[^'"]+\.ts/);
    const serverRuntime = readFileSync(resolve(root, 'dist-runtime', 'server.mjs'), 'utf8');
    assert.match(serverRuntime, /const runtimeEntry = resolve\(SERVER_DIR, 'collect\.mjs'\)/);
    assert.match(serverRuntime, /resolve\(SERVER_DIR, '\.\.', 'src', 'collect\.ts'\)/);
    for (const module of ['cli.mjs', 'server.mjs', 'client/shared/types.mjs']) {
      const syntax = spawnSync(process.execPath, ['--check', resolve(root, 'dist-runtime', module)], { encoding: 'utf8' });
      assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
    }
  } finally {
    rmSync(resolve(root, 'dist-runtime'), { recursive: true, force: true });
  }
});

test('package bin uses a stable checked-in launcher', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(pkg.bin?.['token-work'], 'bin/token-work.mjs');
  assert.equal(pkg.files?.includes('render.yaml'), false);
  const launcher = readFileSync(resolve(root, 'bin', 'token-work.mjs'), 'utf8');
  assert.match(launcher, /^#!\/usr\/bin\/env node/);
  assert.match(launcher, /dist-runtime', 'cli\.mjs'/);
  assert.match(launcher, /src', 'cli\.ts'/);
});

test('npx smoke exercises the installed package through npx', () => {
  const smoke = readFileSync(resolve(root, 'scripts', 'smoke-npx.ts'), 'utf8');
  assert.match(smoke, /spawnNpxCli\(\[/);
  assert.match(smoke, /spawn\('npx', \['--no-install', 'token-work'/);
  assert.match(smoke, /cmd\.exe/);
  assert.doesNotMatch(smoke, /spawn\(process\.execPath,\s*\[\s*cliPath/);
});

test('desktop keeps the tray alive without using a nonexistent close event argument', () => {
  const source = readFileSync(resolve(root, 'desktop', 'main.ts'), 'utf8');
  assert.match(source, /app\.on\('window-all-closed', \(\) =>/);
  assert.doesNotMatch(source, /window-all-closed[\s\S]{0,100}preventDefault/);
});

test('docker compose remote bind is explicit and keeps collector home read-only', () => {
  const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /HOST:\s+"0\.0\.0\.0"/);
  assert.match(compose, /INGEST_TOKEN:/);
  assert.match(compose, /TOKEN_WORK_ALLOW_REMOTE:\s+"1"/);
  assert.match(compose, /TOKEN_WORK_COLLECTOR_HOME/);
  assert.match(compose, /:\/collector-home:ro/);
});

test('scheduled pricing refresh reuses the main pricing files on test', () => {
  const workflow = readFileSync(resolve(root, '.github', 'workflows', 'update-pricing.yml'), 'utf8');
  assert.match(workflow, /- cron: '15 17 \* \* 1'/);
  assert.match(workflow, /update-pricing-test:[\s\S]+needs: update-pricing-main/);
  assert.match(workflow, /git fetch origin main --depth=1/);
  assert.match(workflow, /git checkout FETCH_HEAD -- src\/pricing\.ts data\/official-pricing\.json test\/official-pricing\.test\.ts/);
  const pricingCommitPattern = /file_pattern: "src\/pricing\.ts data\/official-pricing\.json test\/official-pricing\.test\.ts"/g;
  assert.equal([...workflow.matchAll(pricingCommitPattern)].length, 2);
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch'[\s\S]+run: npm run pricing:update/);
  assert.match(workflow, /concurrency:[\s\S]+group: update-pricing[\s\S]+cancel-in-progress: false/);
  assert.match(workflow, /run: npm run test:pricing/);
  assert.doesNotMatch(workflow, /run: npm test/);
});

test('release gate only skips the exact automated pricing commit', () => {
  const workflow = readFileSync(resolve(root, '.github', 'workflows', 'release-gate.yml'), 'utf8');
  assert.match(workflow, /concurrency:[\s\S]+cancel-in-progress: true/);
  assert.match(workflow, /github\.actor != 'github-actions\[bot\]'/);
  assert.match(workflow, /github\.event\.head_commit\.message != 'chore: refresh official model pricing'/);
  assert.doesNotMatch(workflow, /paths-ignore:/);
});

test('.dockerignore excludes private runtime data from build context', () => {
  const ignorePath = resolve(root, '.dockerignore');
  assert.equal(existsSync(ignorePath), true);
  const ignore = readFileSync(ignorePath, 'utf8');
  assert.match(ignore, /^data\/\*$/m);
  assert.match(ignore, /^!data\/\.gitkeep$/m);
  assert.match(ignore, /^node_modules$/m);
  assert.match(ignore, /^dist$/m);
  assert.match(ignore, /^dist-runtime$/m);
});

test('vendored picomatch keeps the CVE-2026-112366 backport', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.workspaces, ['vendor/picomatch']);

  const picomatch = requireFromRoot('picomatch');
  assert.equal(requireFromRoot('picomatch/package.json').version, '4.0.8');

  // 单个分支的重复 extglob 不应再生成嵌套量词
  for (const pattern of ['+(*)', '+(*a)', '*(*a)', '+(a*b)', '*(*.js)']) {
    assert.doesNotMatch(picomatch.makeRe(pattern).source, /\)[+*]/, pattern);
  }

  const started = Date.now();
  assert.equal(picomatch.isMatch('a'.repeat(60) + 'b', '+(*a)'), false);
  assert.ok(Date.now() - started < 200, 'repeated extglob must not backtrack for seconds');
});
