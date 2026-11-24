import { defineConfig } from '@vscode/test-cli';
import { createMultiRootWorkspace } from './test-fixtures/multiroot.mjs';

const common = {
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'tdd', timeout: 20000 },
};

// npm test runs both; `npx vscode-test --label multi-root` runs one
export default defineConfig([
  {
    ...common,
    label: 'single-folder',
    files: 'out/test/*.test.js',
    workspaceFolder: './test-fixtures/workspace',
  },
  {
    ...common,
    label: 'multi-root',
    files: 'out/test/multiroot/*.test.js',
    workspaceFolder: createMultiRootWorkspace(),
  },
]);
