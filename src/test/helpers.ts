import * as vscode from 'vscode';
import { ExtensionApi } from '../extension';
import { getLaunchConfigs, LaunchConfig, runningLaunchNames } from '../launchConfigs';
import { GroupScope } from '../projects';
import { VirtualGroup } from '../taskTreeProvider';

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

/**
 * Saves the groups of the scope (the only one of a single-folder window by default), and waits until they stay
 * saved. Right after a write VS Code may hand the extension the globalState as it was before it, for a moment: a
 * command reading the groups then would work on the old ones, and write them back.
 */
export async function saveGroups(api: ExtensionApi, groups: VirtualGroup[], scope: GroupScope = api.shared.scopes[0]): Promise<void> {
  const expected = JSON.stringify(groups);
  let steady = 0;
  await waitFor(async () => {
    if (JSON.stringify(api.loadGroups(scope)) !== expected) {
      steady = 0;
      await api.saveGroups(groups, scope);
      return false;
    }
    return ++steady >= 3;
  }, `the groups of ${scope.label} to be saved`);
}

export async function getTask(name: string): Promise<vscode.Task> {
  const tasks = await vscode.tasks.fetchTasks();
  const task = tasks.find(t => t.name === name);
  if (!task) { throw new Error(`Fixture task "${name}" not found`); }
  return task;
}

// A task terminated right after it starts may not be known to VS Code yet ("Task to terminate not found"), and keeps
// running: terminate the tasks left every second until none is
export async function stopAllTasks(): Promise<void> {
  let lastTerminate = 0;
  await waitFor(() => {
    if (vscode.tasks.taskExecutions.length === 0) { return true; }
    if (Date.now() - lastTerminate >= 1000) {
      lastTerminate = Date.now();
      for (const e of vscode.tasks.taskExecutions) { e.terminate(); }
    }
    return false;
  }, 'all tasks to stop');
}

// Closes every terminal and waits until they are gone: a task started meanwhile could get one that is closing
export async function disposeAllTerminals(): Promise<void> {
  for (const t of vscode.window.terminals) { t.dispose(); }
  await waitFor(() => vscode.window.terminals.length === 0, 'the terminals to close');
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
    if (!next) {
      throw new Error(`Unexpected showQuickPick call offering ${resolved.map(i => (typeof i === 'string' ? i : i.label)).join(', ')}`);
    }
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

export interface FakeQuickPick<T extends vscode.QuickPickItem> {
  readonly picker: vscode.QuickPick<T>;
  // Ticks these items and presses Enter
  accept(items: readonly T[]): void;
  // Clicks a button of the title
  trigger(button: vscode.QuickInputButton): void;
  // Escape
  hide(): void;
}

// Replaces createQuickPick with a fake the test answers; `shown()` waits for the picker to be shown
export function fakeQuickPick<T extends vscode.QuickPickItem>(): { shown(): Promise<FakeQuickPick<T>> } {
  let shown: FakeQuickPick<T> | undefined;
  stub(vscode.window, 'createQuickPick', (() => {
    const accepted = new vscode.EventEmitter<void>();
    const hidden = new vscode.EventEmitter<void>();
    const triggered = new vscode.EventEmitter<vscode.QuickInputButton>();
    const picker = {
      items: [] as readonly T[],
      selectedItems: [] as readonly T[],
      buttons: [] as readonly vscode.QuickInputButton[],
      onDidAccept: accepted.event,
      onDidHide: hidden.event,
      onDidTriggerButton: triggered.event,
      show: () => {
        shown = {
          picker: picker as unknown as vscode.QuickPick<T>,
          accept: items => {
            picker.selectedItems = items;
            accepted.fire();
          },
          trigger: button => triggered.fire(button),
          hide: () => hidden.fire(),
        };
      },
      hide: () => hidden.fire(),
      dispose: () => undefined,
    };
    return picker;
  }) as unknown as typeof vscode.window.createQuickPick);
  return { shown: () => waitFor(() => shown, 'the picker to be shown') };
}

// A Memento kept in memory, for the state of a workspace
export function memoryMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) { values.delete(key); } else { values.set(key, value); }
    },
  } as vscode.Memento;
}
