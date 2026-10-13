import * as vscode from 'vscode';

export interface LaunchConfig {
  name: string;
  // undefined for configurations defined in the .code-workspace file
  folder: vscode.WorkspaceFolder | undefined;
  // Debugger type and request (e.g. "node", "launch"); undefined for compounds
  type?: string;
  request?: string;
  // Names of the configurations a compound starts
  compound?: string[];
}

interface RawConfiguration { name?: string; type?: string; request?: string; }
interface RawCompound { name?: string; configurations?: (string | { name: string })[]; }

type LaunchSection = { configurations?: RawConfiguration[]; compounds?: RawCompound[] };

function toLaunchConfigs(folder: vscode.WorkspaceFolder | undefined, section: LaunchSection): LaunchConfig[] {
  const configs: LaunchConfig[] = [];
  for (const c of section.configurations ?? []) {
    if (c.name) { configs.push({ name: c.name, folder, type: c.type, request: c.request }); }
  }
  for (const c of section.compounds ?? []) {
    if (!c.name) { continue; }
    const compound = (c.configurations ?? []).map(member => (typeof member === 'string' ? member : member.name));
    configs.push({ name: c.name, folder, compound });
  }
  return configs;
}

// Launch configurations and compounds of every workspace folder, in launch.json order
export function getLaunchConfigs(): LaunchConfig[] {
  // Read each level on its own: the merged value would repeat the .code-workspace
  // configurations under every folder that has no launch.json
  const multiRoot = vscode.workspace.workspaceFile !== undefined;
  const configs: LaunchConfig[] = [];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const launch = vscode.workspace.getConfiguration('launch', folder);
    const own = <T>(key: string): T | undefined => {
      const value = launch.inspect<T>(key);
      // In a single-folder window launch.json is the workspace level
      return value?.workspaceFolderValue ?? (multiRoot ? undefined : value?.workspaceValue);
    };
    configs.push(...toLaunchConfigs(folder, {
      configurations: own('configurations'),
      compounds: own('compounds'),
    }));
  }

  if (multiRoot) {
    const launch = vscode.workspace.getConfiguration('launch');
    configs.push(...toLaunchConfigs(undefined, {
      configurations: launch.inspect<RawConfiguration[]>('configurations')?.workspaceValue,
      compounds: launch.inspect<RawCompound[]>('compounds')?.workspaceValue,
    }));
  }

  return configs;
}

// The API only exposes the active debug session, so the running ones are tracked from the lifecycle events
const sessions = new Map<string, vscode.DebugSession>();

export function trackDebugSessions(onChange: () => void): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.debug.onDidStartDebugSession(s => {
      sessions.set(s.id, s);
      onChange();
    }),
    vscode.debug.onDidTerminateDebugSession(s => {
      sessions.delete(s.id);
      onChange();
    }),
  );
}

// Sessions started from a launch configuration; debuggers may spawn child sessions with other names
function rootSessions(): vscode.DebugSession[] {
  return [...sessions.values()].filter(s => !s.parentSession);
}

export function runningLaunchNames(): Set<string> {
  return new Set(rootSessions().map(s => s.configuration.name));
}

// A compound has no session of its own: it is running while all its configurations are
export function isLaunchRunning(config: LaunchConfig, running: Set<string>): boolean {
  if (!config.compound) { return running.has(config.name); }
  return config.compound.length > 0 && config.compound.every(name => running.has(name));
}

export async function startLaunch(config: LaunchConfig, noDebug = false): Promise<void> {
  try {
    await vscode.debug.startDebugging(config.folder, config.name, { noDebug });
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to start "${config.name}": ${err}`);
  }
}

export async function stopLaunch(config: LaunchConfig): Promise<void> {
  const names = config.compound ?? [config.name];
  await Promise.all(
    rootSessions()
      .filter(s => names.includes(s.configuration.name))
      .map(s => vscode.debug.stopDebugging(s)),
  );
}
