import * as vscode from 'vscode';
import { ExtensionApi } from '../extension';
import { getLaunchConfigs, LaunchConfig, runningLaunchNames } from '../launchConfigs';

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

// Overrides the given settings (by key, in any section) until restoreStubs()
export function withSettings(values: Record<string, unknown>): void {
  const original = vscode.workspace.getConfiguration;
  stub(vscode.workspace, 'getConfiguration', ((section?: string) => {
    const config = original(section);
    return {
      ...config,
      get: (key: string, fallback?: unknown) => (key in values ? values[key] : config.get(key, fallback)),
    };
  }) as typeof vscode.workspace.getConfiguration);
}

type Pickable = string | vscode.QuickPickItem;

// Answers each showQuickPick call in turn: `choose` receives the offered items and returns the pick
// (an array of picks for a canPickMany pick)
export function answerQuickPicks(
  ...choose: ((items: Pickable[]) => Pickable | Pickable[] | undefined)[]
): Pickable[][] {
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

export const pickMany = (...labels: string[]) => (items: Pickable[]) =>
  items.filter(i => labels.includes(typeof i === 'string' ? i : i.label));

export const cancel = () => undefined;

// Answers showSaveDialog with `uri` and records the options it was called with
export function answerSaveDialog(uri: vscode.Uri | undefined): vscode.SaveDialogOptions[] {
  const calls: vscode.SaveDialogOptions[] = [];
  stub(vscode.window, 'showSaveDialog', (async (options?: vscode.SaveDialogOptions) => {
    calls.push(options ?? {});
    return uri;
  }) as typeof vscode.window.showSaveDialog);
  return calls;
}

// Answers showOpenDialog with `uri` as the only file picked
export function answerOpenDialog(uri: vscode.Uri | undefined): void {
  stub(vscode.window, 'showOpenDialog', (async () => (uri ? [uri] : undefined)) as typeof vscode.window.showOpenDialog);
}

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

export function getLaunch(name: string): LaunchConfig {
  const config = getLaunchConfigs().find(c => c.name === name);
  if (!config) { throw new Error(`Fixture launch configuration "${name}" not found`); }
  return config;
}

export async function waitForDebugging(name: string): Promise<void> {
  await waitFor(() => runningLaunchNames().has(name), `"${name}" to start debugging`);
}

export async function stopAllDebugSessions(): Promise<void> {
  await vscode.debug.stopDebugging();
  await waitFor(() => runningLaunchNames().size === 0, 'all debug sessions to stop');
}

// Replaces createInputBox with a fake the test types into
export function fakeInputBox(): { box: vscode.InputBox; type(value: string): void; accept(): void } {
  const change = new vscode.EventEmitter<string>();
  const accepted = new vscode.EventEmitter<void>();
  const hidden = new vscode.EventEmitter<void>();
  const box = {
    value: '',
    onDidChangeValue: change.event,
    onDidAccept: accepted.event,
    onDidHide: hidden.event,
    show: () => undefined,
    hide: () => hidden.fire(),
    dispose: () => undefined,
  } as unknown as vscode.InputBox;
  stub(vscode.window, 'createInputBox', () => box);
  return {
    box,
    type: value => {
      box.value = value;
      change.fire(value);
    },
    accept: () => accepted.fire(),
  };
}
