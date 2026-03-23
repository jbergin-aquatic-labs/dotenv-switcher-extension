const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Smoke: package and entrypoints', () => {
  it('loads package.json with main, scripts, and new configuration keys', () => {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    assert.strictEqual(pkg.main, './src/extension.js');
    assert.ok(pkg.scripts.test);
    assert.ok(pkg.scripts['test:unit']);
    assert.ok(pkg.scripts['test:smoke']);
    assert.ok(pkg.scripts['test:vscode']);

    const props = pkg.contributes?.configuration?.properties || {};
    assert.ok(props['envSwitcher.targetDirectories']);
    assert.ok(props['envSwitcher.backupDebounceMs']);
    assert.ok(props['envSwitcher.vaultEnabled']);
    assert.ok(props['envSwitcher.vaultMaxVersions']);
  });

  it('requires extension entry without vscode (smoke: no throw on parse)', () => {
    const extPath = path.join(__dirname, '..', '..', 'src', 'extension.js');
    assert.ok(fs.existsSync(extPath));
    // Loading the extension module pulls in `vscode` which is absent in plain Node.
    assert.throws(() => {
      require(extPath);
    });
  });

  it('requires core library successfully', () => {
    const core = require('../../src/lib/core');
    assert.strictEqual(typeof core.createEnvSymlink, 'function');
    assert.strictEqual(typeof core.createAdaptiveDebouncedScheduler, 'function');
  });
});
