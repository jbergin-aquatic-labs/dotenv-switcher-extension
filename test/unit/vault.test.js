const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('../../src/lib/core');
const vault = require('../../src/lib/vault');

describe('vault: getVaultRoot', () => {
  it('uses global storage path by default', () => {
    const r = vault.getVaultRoot({ globalStoragePath: '/g', location: 'globalStorage' });
    assert.strictEqual(r, path.join('/g', 'env-vault'));
  });

  it('uses user home when configured', () => {
    const r = vault.getVaultRoot({ globalStoragePath: '/g', location: 'userHome', homeDir: '/home/u' });
    assert.strictEqual(r, path.join('/home/u', '.env-switcher-vault'));
  });
});

describe('vault: snapshots and restore', () => {
  let tmp;
  let workspaceRoot;
  let envFolder;
  let vaultRoot;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-vault-'));
    workspaceRoot = path.join(tmp, 'ws');
    envFolder = path.join(workspaceRoot, '.envs');
    fs.mkdirSync(path.join(envFolder, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(envFolder, 'a.env'), 'A=1');
    fs.writeFileSync(path.join(envFolder, 'nested', 'b.env'), 'B=2');
    fs.mkdirSync(path.join(workspaceRoot, 'pkg'));
    core.createEnvSymlink(workspaceRoot, envFolder, 'a.env', '.env');
    vaultRoot = path.join(tmp, 'vault');
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a snapshot with hierarchical files and assignments', () => {
    const r1 = vault.createSnapshot(workspaceRoot, envFolder, {
      vaultRoot,
      envFolderName: '.envs',
      targetFile: '.env',
      targetDirectories: ['.', 'pkg'],
      maxVersions: 10,
      skipIfUnchanged: false,
    });
    assert.strictEqual(r1.skipped, false);
    assert.ok(r1.snapshotId);
    assert.strictEqual(r1.fileCount, 2);

    const snaps = vault.listSnapshots(vaultRoot, workspaceRoot);
    assert.strictEqual(snaps.length, 1);
    const m = vault.getSnapshotManifest(vaultRoot, workspaceRoot, r1.snapshotId);
    assert.ok(m.assignments['.']);
    assert.strictEqual(m.files.includes('nested/b.env'), true);
  });

  it('skips auto snapshot when fingerprint unchanged', () => {
    const r2 = vault.createSnapshot(workspaceRoot, envFolder, {
      vaultRoot,
      envFolderName: '.envs',
      targetFile: '.env',
      targetDirectories: ['.'],
      maxVersions: 10,
      skipIfUnchanged: true,
    });
    assert.strictEqual(r2.skipped, true);
    assert.strictEqual(r2.reason, 'unchanged');
  });

  it('restores a single file from a snapshot', () => {
    const snaps = vault.listSnapshots(vaultRoot, workspaceRoot);
    const id = snaps[0].snapshotId;
    fs.writeFileSync(path.join(envFolder, 'a.env'), 'CORRUPTED');
    vault.restoreFileToEnvFolder(workspaceRoot, envFolder, vaultRoot, id, 'a.env');
    assert.strictEqual(fs.readFileSync(path.join(envFolder, 'a.env'), 'utf8'), 'A=1');
  });

  it('restores full tree and prunes old snapshots', () => {
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(envFolder, 'a.env'), `A=${i}`);
      vault.createSnapshot(workspaceRoot, envFolder, {
        vaultRoot,
        envFolderName: '.envs',
        targetFile: '.env',
        targetDirectories: ['.'],
        maxVersions: 3,
        skipIfUnchanged: false,
      });
    }
    const snapRoot = vault.snapshotsDir(vaultRoot, workspaceRoot);
    const count = vault.listSnapshotIdsDesc(snapRoot).length;
    assert.ok(count <= 3);
  });
});
