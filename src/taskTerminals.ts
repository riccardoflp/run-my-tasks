import * as vscode from 'vscode';

export type TerminalLocation = 'panel' | 'editor';

// How the terminals open in the editor area: each in its own group side by side,
// all in one group beside the editors, or as tabs of the active group
type EditorTerminalLayout = 'split' | 'group' | 'tab';

// Where the terminals go with respect to the editors, when they get a group of their own
type EditorTerminalPosition = 'right' | 'below';

// Commands focusing the editor group in view column 1..8
const FOCUS_GROUP_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

// How long to wait for the terminal of a task that has just started
const TERMINAL_TIMEOUT_MS = 3000;

// The tasks started by the extension whose terminal has to go to the editor area, until they start
const pendingMoves = new Set<string>();

// Moving a terminal goes through the active terminal and editor group: one move at a time
let moves: Promise<void> = Promise.resolve();

// Resolves once the terminals of the tasks started so far are in place
export function terminalsPlaced(): Promise<void> {
  return moves;
}

export function configuredLocation(): TerminalLocation {
  return vscode.workspace.getConfiguration('runMyTasks').get<TerminalLocation>('terminalLocation', 'panel');
}

// Runs the task with its terminal in `location`, the configured one when not given
export async function runTask(task: vscode.Task, location = configuredLocation()): Promise<vscode.TaskExecution> {
  // A task that does not reveal its terminal keeps it hidden in the panel. The others reveal it
  // there first: VS Code stops tracking a task started with reveal "never" once its terminal moves
  const reveal = task.presentationOptions.reveal ?? vscode.TaskRevealKind.Always;
  if (location !== 'editor' || reveal !== vscode.TaskRevealKind.Always) {
    pendingMoves.delete(task.name);
    return vscode.tasks.executeTask(task);
  }

  pendingMoves.add(task.name);
  try {
    return await vscode.tasks.executeTask(task);
  } catch (err) {
    pendingMoves.delete(task.name);
    throw err;
  }
}

// The API has no link from TaskExecution to Terminal: match by the terminal title
// VS Code gives task terminals ("Task - <name>", or just "<name>" in newer versions).
// The newest one first: an older terminal with the same title may be closing
export function findTaskTerminal(name: string): vscode.Terminal | undefined {
  const newestFirst = [...vscode.window.terminals].reverse();
  return newestFirst.find(t => t.name === `Task - ${name}`) ?? newestFirst.find(t => t.name === name);
}

// Moves the terminals of the tasks started by runTask() to the editor area when asked to
export function trackTaskTerminals(): vscode.Disposable {
  return vscode.tasks.onDidStartTask(e => {
    const task = e.execution.task;
    if (!pendingMoves.delete(task.name)) { return; }
    moves = moves.then(() => moveToEditor(task)).catch(() => undefined);
  });
}

function isInEditor(terminal: vscode.Terminal): boolean {
  return vscode.window.tabGroups.all.some(g =>
    g.tabs.some(t => t.input instanceof vscode.TabInputTerminal && t.label === terminal.name),
  );
}

function isTerminalGroup(group: vscode.TabGroup): boolean {
  return group.tabs.length > 0 && group.tabs.every(t => t.input instanceof vscode.TabInputTerminal);
}

// VS Code locks a group of terminals when more groups are open (workbench.editor.autoLockGroups),
// and would open the terminal elsewhere: unlock the active group for the terminal.
// Returns whether to lock it again afterwards, as VS Code would
async function unlockForTerminal(): Promise<boolean> {
  await vscode.commands.executeCommand('workbench.action.unlockEditorGroup');
  const autoLock = vscode.workspace.getConfiguration('workbench.editor').get<Record<string, boolean>>('autoLockGroups');
  return (autoLock?.terminalEditor ?? true) && vscode.window.tabGroups.all.length > 1;
}

// The terminal gets its title a moment after the task starts
async function waitForTaskTerminal(name: string): Promise<vscode.Terminal | undefined> {
  const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
  for (;;) {
    const terminal = findTaskTerminal(name);
    if (terminal || Date.now() > deadline) { return terminal; }
    await new Promise(r => setTimeout(r, 100));
  }
}

async function moveToEditor(task: vscode.Task): Promise<void> {
  const terminal = await waitForTaskTerminal(task.name);
  // A terminal reused by the task may already be in the editor area
  if (!terminal || isInEditor(terminal)) { return; }

  const sourceGroup = vscode.window.tabGroups.activeTabGroup;
  const sourceColumn = sourceGroup.viewColumn;
  // With no editor open there is nothing to put the terminals beside
  const layout = sourceGroup.tabs.length > 0
    ? vscode.workspace.getConfiguration('runMyTasks').get<EditorTerminalLayout>('editorTerminalLayout', 'split')
    : 'tab';
  const position = vscode.workspace.getConfiguration('runMyTasks').get<EditorTerminalPosition>('editorTerminalPosition', 'right');
  const newGroupCommand = position === 'below' ? 'workbench.action.newGroupBelow' : 'workbench.action.newGroupRight';

  // The terminal is opened in its group rather than moved there later:
  // VS Code loses track of a terminal editor moved to another group, and never closes it
  let relock = false;
  if (layout === 'split') {
    // Each terminal in a new group, after the terminals already split beside the editors the user
    // is working on: all to the right of each other, or all below each other
    let anchorColumn = sourceColumn;
    while (vscode.window.tabGroups.all.some(g => g.viewColumn === anchorColumn + 1 && isTerminalGroup(g))) {
      anchorColumn++;
    }
    const focusAnchor = FOCUS_GROUP_COMMANDS[anchorColumn - 1];
    if (focusAnchor && anchorColumn !== sourceColumn) {
      await vscode.commands.executeCommand(focusAnchor);
    }
    await vscode.commands.executeCommand(newGroupCommand);
  } else if (isTerminalGroup(sourceGroup) || sourceGroup.tabs.length === 0) {
    // Started with no file open: the terminals join the group of the first one
    relock = await unlockForTerminal();
  } else if (layout === 'group') {
    // All together in the group of terminals beside the editors, created when missing
    const nextGroup = vscode.window.tabGroups.all.find(g => g.viewColumn === sourceColumn + 1);
    const focusNextGroup = FOCUS_GROUP_COMMANDS[sourceColumn];
    if (nextGroup && isTerminalGroup(nextGroup) && focusNextGroup) {
      await vscode.commands.executeCommand(focusNextGroup);
      relock = await unlockForTerminal();
    } else {
      await vscode.commands.executeCommand(newGroupCommand);
    }
  }

  // moveToEditor acts on the active terminal of the panel, and opens it in the active editor group
  terminal.show(true);
  await vscode.commands.executeCommand('workbench.action.terminal.moveToEditor');

  if (relock) {
    await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
  }

  // The panel was opened only to move the terminal out of it, by the task and by show()
  if (isInEditor(terminal)) {
    await vscode.commands.executeCommand('workbench.action.closePanel');
  }

  const focusSource = FOCUS_GROUP_COMMANDS[sourceColumn - 1];
  if (layout !== 'tab' && !task.presentationOptions.focus && focusSource) {
    await vscode.commands.executeCommand(focusSource);
  }
}
