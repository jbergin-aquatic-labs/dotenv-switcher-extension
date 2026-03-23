const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

describe('Integration: extension host', function () {
  this.timeout(60_000);

  it('exposes the extension and activates', async () => {
    const ext = vscode.extensions.getExtension('aquatic-labs.env-switcher');
    assert.ok(ext, 'Extension aquatic-labs.env-switcher should be present');
    await ext.activate();
  });

  it('registers every command declared in package.json (non-breaking surface)', async () => {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const contributed = (pkg.contributes?.commands || []).map((c) => c.command);
    assert.ok(contributed.length > 0, 'package.json should declare commands');

    const cmds = await vscode.commands.getCommands(true);
    const missing = contributed.filter((id) => !cmds.includes(id));
    assert.strictEqual(
      missing.length,
      0,
      `Extension host missing registered commands (breaking change?): ${missing.join(', ')}`
    );
  });

  it('loads workspace fixture with a .envs directory', () => {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length >= 1);
    const root = folders[0].uri.fsPath;
    assert.ok(fs.existsSync(path.join(root, '.envs')));
  });
});
