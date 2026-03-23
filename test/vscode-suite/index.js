const path = require('path');
const Mocha = require('mocha');
const { globSync } = require('glob');

/**
 * @returns {Promise<void>}
 */
function run() {
  const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 60_000 });
  const grep = process.env.VSCODE_TEST_GREP;
  if (grep) {
    mocha.grep(new RegExp(grep));
  }
  const testsRoot = __dirname;
  for (const f of globSync('**/*.test.js', { cwd: testsRoot, absolute: true })) {
    mocha.addFile(f);
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed`));
      } else {
        resolve();
      }
    });
  });
}

module.exports = { run };
