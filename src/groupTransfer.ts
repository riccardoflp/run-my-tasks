import { groupEntries, VirtualGroup } from './taskTreeProvider';

// Version of the file written by Export Groups; files of a later version are refused
export const GROUPS_FILE_VERSION = 1;

interface GroupsFile {
  version: number;
  groups: { name: string; tasks: string[]; launches: string[] }[];
}

export function serializeGroups(groups: VirtualGroup[]): string {
  const file: GroupsFile = {
    version: GROUPS_FILE_VERSION,
    groups: groups.map(g => ({ name: g.name, tasks: g.tasks, launches: groupEntries(g, 'launches') })),
  };
  return JSON.stringify(file, null, 2) + '\n';
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(v => typeof v === 'string');

/** The groups of an exported file; throws an Error telling what is wrong with it. */
export function parseGroups(text: string): VirtualGroup[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('not a valid JSON file');
  }
  const file = data as Partial<GroupsFile> | null;
  if (typeof file !== 'object' || file === null || !Array.isArray(file.groups)) {
    throw new Error('not a file of exported groups');
  }
  if (typeof file.version !== 'number') {
    throw new Error('missing version');
  }
  if (file.version > GROUPS_FILE_VERSION) {
    throw new Error('exported by a newer version of Run My Tasks');
  }

  const groups: VirtualGroup[] = [];
  for (const [index, raw] of (file.groups as unknown[]).entries()) {
    const g = raw as Partial<VirtualGroup> | null;
    const name = typeof g?.name === 'string' ? g.name.trim() : '';
    if (!name) {
      throw new Error(`group ${index + 1} has no name`);
    }
    if (!isStringArray(g!.tasks) || (g!.launches !== undefined && !isStringArray(g!.launches))) {
      throw new Error(`group "${name}" has invalid tasks or launch configurations`);
    }
    if (groups.some(other => other.name === name)) {
      throw new Error(`group "${name}" appears twice`);
    }
    const launches = g!.launches ?? [];
    groups.push({ name, tasks: [...g!.tasks], ...(launches.length > 0 ? { launches: [...launches] } : {}) });
  }
  return groups;
}

/** `existing` with the tasks and launch configurations of `imported` it lacks appended. */
export function mergeGroup(existing: VirtualGroup, imported: VirtualGroup): VirtualGroup {
  const union = (a: string[], b: string[]): string[] => [...a, ...b.filter(e => !a.includes(e))];
  const launches = union(groupEntries(existing, 'launches'), groupEntries(imported, 'launches'));
  return {
    ...existing,
    tasks: union(existing.tasks, imported.tasks),
    ...(existing.launches || launches.length > 0 ? { launches } : {}),
  };
}
