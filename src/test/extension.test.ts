import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension', () => {
  test('registers all contributed commands', async () => {
    const ext = vscode.extensions.getExtension('RiccardoFilippozzi.run-my-tasks');
    assert.ok(ext, 'extension not found');
    await ext.activate();

    const contributed: string[] = ext.packageJSON.contributes.commands.map((c: { command: string }) => c.command);
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = contributed.filter(c => !registered.has(c));
    assert.deepStrictEqual(missing, []);
  });
});
