import * as vscode from 'vscode';

interface TaskQuickPickItem extends vscode.QuickPickItem {
  task: vscode.Task;
}

export async function showTaskPicker(): Promise<void> {
  let tasks: vscode.Task[];
  try {
    tasks = await vscode.tasks.fetchTasks();
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to fetch tasks: ${err}`);
    return;
  }

  if (tasks.length === 0) {
    vscode.window.showInformationMessage(
      'No tasks found. Add tasks to .vscode/tasks.json to get started.',
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('runMyTasks');
  const showType = config.get<boolean>('showTaskType', true);

  // Group tasks by source, Workspace first then alphabetical
  const groups = new Map<string, vscode.Task[]>();
  for (const task of tasks) {
    const bucket = groups.get(task.source) ?? [];
    bucket.push(task);
    groups.set(task.source, bucket);
  }
  const sortedSources = [...groups.keys()].sort((a, b) => {
    if (a === 'Workspace') { return -1; }
    if (b === 'Workspace') { return 1; }
    return a.localeCompare(b);
  });

  const items: vscode.QuickPickItem[] = [];
  for (const source of sortedSources) {
    items.push({ label: source, kind: vscode.QuickPickItemKind.Separator });

    const sourceTasks = (groups.get(source) ?? []).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const task of sourceTasks) {
      const item: TaskQuickPickItem = {
        label: `$(run) ${task.name}`,
        task,
      };
      if (showType) {
        item.detail = buildTaskDetail(task);
      }
      items.push(item);
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a task to run...',
    matchOnDetail: true,
  });

  if (!selected || !('task' in selected)) {
    return;
  }

  try {
    await vscode.tasks.executeTask((selected as TaskQuickPickItem).task);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to run task "${(selected as TaskQuickPickItem).task.name}": ${err}`);
  }
}

function buildTaskDetail(task: vscode.Task): string | undefined {
  const def = task.definition;
  if (def.type === 'shell' && def.command) {
    const cmd: string = typeof def.command === 'string' ? def.command : (def.command?.value ?? '');
    return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
  }
  if (def.type === 'npm' && def.script) {
    return `npm run ${def.script}`;
  }
  return undefined;
}
