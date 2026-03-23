const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('../../src/lib/core');

describe('core: getTargetDirectories', () => {
  it('defaults to a single workspace root entry', () => {
    assert.deepStrictEqual(core.getTargetDirectories(undefined), ['.']);
    assert.deepStrictEqual(core.getTargetDirectories([]), ['.']);
  });

  it('trims and drops empty segments', () => {
    assert.deepStrictEqual(core.getTargetDirectories(['  .  ', '', 'pkg']), ['.', 'pkg']);
  });
});

describe('core: listAllEnvFiles and descriptors', () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-switcher-'));
    const envs = path.join(tmp, '.envs');
    fs.mkdirSync(path.join(envs, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(envs, 'a.env'), 'A=1');
    fs.writeFileSync(path.join(envs, 'nested', 'b.env'), 'B=2');
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('lists nested env files with stable ordering', () => {
    const envFolder = path.join(tmp, '.envs');
    const files = core.listAllEnvFiles(envFolder);
    assert.deepStrictEqual(files, ['a.env', 'nested/b.env']);
  });

  it('builds quick-pick descriptors with separators', () => {
    const envFolder = path.join(tmp, '.envs');
    const items = core.buildEnvQuickPickDescriptors(envFolder, 'nested/b.env');
    const kinds = items.map((i) => i.kind);
    assert.ok(kinds.includes('separator'));
    assert.ok(kinds.includes('item'));
    const nestedItem = items.find((i) => i.kind === 'item' && i.envRelPath === 'nested/b.env');
    assert.ok(nestedItem.label.includes('check'));
  });
});

describe('core: symlinks', () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-switcher-'));
    const envs = path.join(tmp, '.envs');
    fs.mkdirSync(envs);
    fs.writeFileSync(path.join(envs, 'dev.env'), 'X=1');
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a relative symlink and detects assignment', () => {
    const envFolder = path.join(tmp, '.envs');
    core.createEnvSymlink(tmp, envFolder, 'dev.env', '.env');
    const assigned = core.getAssignedEnv(tmp, envFolder, '.env');
    assert.strictEqual(assigned, 'dev.env');
    assert.strictEqual(core.removeEnvSymlink(tmp, '.env'), true);
    assert.strictEqual(core.getAssignedEnv(tmp, envFolder, '.env'), null);
  });

  it('throws when source env file is missing', () => {
    assert.throws(
      () => core.createEnvSymlink(tmp, path.join(tmp, '.envs'), 'missing.env', '.env'),
      /not found/
    );
  });
});

describe('core: duplicateEnvFileInFolder', () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-switcher-'));
    const envs = path.join(tmp, '.envs');
    fs.mkdirSync(envs);
    fs.writeFileSync(path.join(envs, 'src.env'), 'K=v');
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('copies inside .envs and rejects traversal', () => {
    const envFolder = path.join(tmp, '.envs');
    core.duplicateEnvFileInFolder(envFolder, 'src.env', 'dst.env');
    assert.strictEqual(fs.readFileSync(path.join(envFolder, 'dst.env'), 'utf8'), 'K=v');
    assert.throws(
      () => core.duplicateEnvFileInFolder(envFolder, '../escape.env', 'bad.env'),
      /inside .envs/
    );
  });
});

describe('core: collectAssignments', () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-switcher-'));
    const envs = path.join(tmp, '.envs');
    fs.mkdirSync(envs);
    fs.writeFileSync(path.join(envs, 'r.env'), 'R=1');
    fs.writeFileSync(path.join(envs, 's.env'), 'S=1');
    fs.mkdirSync(path.join(tmp, 'pkg'));
    core.createEnvSymlink(tmp, envs, 'r.env', '.env');
    core.createEnvSymlink(path.join(tmp, 'pkg'), envs, 's.env', '.env');
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records only configured target directories', () => {
    const envFolder = path.join(tmp, '.envs');
    const map = core.collectAssignments(tmp, envFolder, '.env', ['.', 'pkg']);
    assert.strictEqual(map['.'], 'r.env');
    assert.strictEqual(map.pkg, 's.env');
  });
});

describe('core: backup path helpers', () => {
  it('workspaceBackupDir is stable for the same inputs', () => {
    const a = core.workspaceBackupDir('/storage', '/projects/foo');
    const b = core.workspaceBackupDir('/storage', '/projects/foo');
    assert.strictEqual(a, b);
  });
});

describe('core: createAdaptiveDebouncedScheduler', () => {
  it('runs immediately when delay is zero', () => {
    let n = 0;
    const s = core.createAdaptiveDebouncedScheduler(() => 0, () => {
      n += 1;
    });
    s.schedule();
    s.schedule();
    assert.strictEqual(n, 2);
    s.dispose();
  });

  it('coalesces rapid calls when delay is positive', async () => {
    let n = 0;
    const s = core.createAdaptiveDebouncedScheduler(() => 20, () => {
      n += 1;
    });
    s.schedule();
    s.schedule();
    s.schedule();
    assert.strictEqual(n, 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(n, 1);
    s.dispose();
  });
});
