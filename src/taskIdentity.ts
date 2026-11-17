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
