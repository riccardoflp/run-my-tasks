import * as vscode from 'vscode';
import { ExtensionApi } from '../extension';

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

export async function getApi(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension<ExtensionApi>('RiccardoFilippozzi.run-my-tasks');
  if (!ext) { throw new Error('Extension not found'); }
  return ext.activate();
}

// Minimal stubbing: replace a property for the duration of a test, undone by restoreStubs()
const restorers: (() => void)[] = [];

export function stub<T extends object, K extends keyof T>(target: T, key: K, impl: T[K]): void {
  const original = target[key];
  target[key] = impl;
  restorers.push(() => { target[key] = original; });
}

export function restoreStubs(): void {
  while (restorers.length) { restorers.pop()!(); }
}

type Pickable = string | vscode.QuickPickItem;

// Answers each showQuickPick call in turn: `choose` receives the offered items and returns the pick
export function answerQuickPicks(...choose: ((items: Pickable[]) => Pickable | undefined)[]): Pickable[][] {
  const offered: Pickable[][] = [];
  stub(vscode.window, 'showQuickPick', (async (items: readonly Pickable[] | Thenable<readonly Pickable[]>) => {
    const resolved = [...await items];
    offered.push(resolved);
    const next = choose.shift();
    if (!next) { throw new Error('Unexpected showQuickPick call'); }
    return next(resolved);
  }) as typeof vscode.window.showQuickPick);
  return offered;
}

export const pick = (label: string) => (items: Pickable[]) =>
  items.find(i => (typeof i === 'string' ? i : i.label) === label);

export const cancel = () => undefined;

// Answers showInputBox with `value` and records the options it was called with
export function answerInputBox(value: string | undefined): vscode.InputBoxOptions[] {
  const calls: vscode.InputBoxOptions[] = [];
  stub(vscode.window, 'showInputBox', (async (options?: vscode.InputBoxOptions) => {
    calls.push(options ?? {});
    return value;
  }) as typeof vscode.window.showInputBox);
  return calls;
}

export interface Messages { info: string[]; warning: string[]; error: string[]; }

// Records notifications; `reply` is returned as the clicked action (for info messages)
export function captureMessages(reply?: string): Messages {
  const messages: Messages = { info: [], warning: [], error: [] };
  stub(vscode.window, 'showInformationMessage', (async (m: string) => {
    messages.info.push(m);
    return reply;
  }) as typeof vscode.window.showInformationMessage);
  stub(vscode.window, 'showWarningMessage', (async (m: string) => {
    messages.warning.push(m);
    return undefined;
  }) as typeof vscode.window.showWarningMessage);
  stub(vscode.window, 'showErrorMessage', (async (m: string) => {
    messages.error.push(m);
    return undefined;
  }) as typeof vscode.window.showErrorMessage);
  return messages;
}

export async function waitForRunning(name: string): Promise<void> {
  await waitFor(() => vscode.tasks.taskExecutions.some(e => e.task.name === name), `"${name}" to start`);
}

export function runningNames(): string[] {
  return vscode.tasks.taskExecutions.map(e => e.task.name).sort();
}
