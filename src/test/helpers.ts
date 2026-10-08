import * as vscode from 'vscode';

export async function waitFor<T>(
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeoutMs = 10000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) { return value; }
    if (Date.now() > deadline) { throw new Error(`Timed out waiting for ${what}`); }
    await new Promise(r => setTimeout(r, 100));
  }
}

export async function getTask(name: string): Promise<vscode.Task> {
  const tasks = await vscode.tasks.fetchTasks();
  const task = tasks.find(t => t.name === name);
  if (!task) { throw new Error(`Fixture task "${name}" not found`); }
  return task;
}

export async function stopAllTasks(): Promise<void> {
  for (const e of vscode.tasks.taskExecutions) { e.terminate(); }
  await waitFor(() => vscode.tasks.taskExecutions.length === 0, 'all tasks to stop');
}

export function disposeAllTerminals(): void {
  for (const t of vscode.window.terminals) { t.dispose(); }
}
