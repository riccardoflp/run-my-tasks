import * as vscode from 'vscode';

// Tasks are told apart by source, scope and name: tasks.json and a task provider (e.g. the npm
// script "build"), or two folders of a multi-root workspace, may have tasks with the same name
export function taskKey(task: vscode.Task): string {
  const scope = task.scope;
  const scopeId = typeof scope === 'object' ? scope.uri.toString() : String(scope);
  return `${task.source}\u0000${scopeId}\u0000${task.name}`;
}

// The keys of the running tasks, but those in `exclude` (tasks being stopped)
export function runningTaskKeys(exclude: ReadonlySet<string> = new Set()): Set<string> {
  return new Set(
    vscode.tasks.taskExecutions
      .map(e => taskKey(e.task))
      .filter(key => !exclude.has(key)),
  );
}

// Keys of the tasks VS Code reported started, so far as they have not ended
const startedKeys = new Set<string>();

/** Tracks which tasks VS Code has finished starting; the tasks running at activation count as started. */
export function trackTaskStarts(): vscode.Disposable {
  for (const e of vscode.tasks.taskExecutions) { startedKeys.add(taskKey(e.task)); }
  return vscode.Disposable.from(
    vscode.tasks.onDidStartTask(e => { startedKeys.add(taskKey(e.execution.task)); }),
    vscode.tasks.onDidEndTask(e => { startedKeys.delete(taskKey(e.execution.task)); }),
  );
}

// How long a task not started yet is waited for, before it is terminated anyway
const START_TIMEOUT_MS = 5000;

/**
 * Terminates the task. VS Code refuses to terminate a task it has not finished starting ("Task to terminate not
 * found"), which then keeps running: such a task is terminated as soon as VS Code reports it started.
 */
export function terminateTask(execution: vscode.TaskExecution): void {
  const key = taskKey(execution.task);
  if (startedKeys.has(key)) {
    execution.terminate();
    return;
  }
  const done = (): void => {
    listener.dispose();
    clearTimeout(timer);
  };
  const listener = vscode.tasks.onDidStartTask(e => {
    if (taskKey(e.execution.task) !== key) { return; }
    done();
    e.execution.terminate();
  });
  const timer = setTimeout(() => {
    done();
    if (vscode.tasks.taskExecutions.some(e => taskKey(e.task) === key)) { execution.terminate(); }
  }, START_TIMEOUT_MS);
}
