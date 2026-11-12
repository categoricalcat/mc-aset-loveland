import type { ResolvedVersion, VersionDependency } from './types.js';

import { isJsonObject, type Json } from '../json.js';

export interface FabricMod {
  breaks: Record<string, string>;
  conflicts: Record<string, string>;
  file: string;
  id: string;
}

type Rule = (
  mod: ResolvedVersion,
  dep: VersionDependency,
  target: ResolvedVersion,
) => null | string;

type Rules = Partial<Record<string, Rule>>;

const conflictRules: Rules = {
  incompatible: (mod, dep, target) =>
    dep.version_id === null || dep.version_id === target.id
      ? `${mod.path} is incompatible with ${target.path}`
      : null,
};

// Pins are usually the version current at upload, and loaders dedupe
// jar-in-jar copies, so these do not block the update.
const warningRules: Rules = {
  embedded: (mod, _dep, target) =>
    `${mod.path} embeds ${target.path}, also shipped as its own file`,
  required: (mod, dep, target) =>
    dep.version_id !== null && dep.version_id !== target.id
      ? `${mod.path} pins version ${dep.version_id} of ${target.path}`
      : null,
};

const versionRange = (value: Json | undefined): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.filter(item => typeof item === 'string').join(' || ')
      : '*';

const modIdMap = (value: Json | undefined): Record<string, string> =>
  value !== undefined && isJsonObject(value)
    ? Object.fromEntries(
        Object.entries(value).map(([id, range]) => [id, versionRange(range)]),
      )
    : {};

export const parseFabricMod = (body: Json, file: string): FabricMod | null =>
  isJsonObject(body) && typeof body['id'] === 'string'
    ? {
        breaks: modIdMap(body['breaks']),
        conflicts: modIdMap(body['conflicts']),
        file,
        id: body['id'],
      }
    : null;

const graphMessages = (
  mods: readonly ResolvedVersion[],
  byProject: ReadonlyMap<string, ResolvedVersion[]>,
  rules: Rules,
): string[] => {
  const byVersion = Map.groupBy<null | string, ResolvedVersion>(
    mods,
    mod => mod.id,
  );
  return mods.flatMap(mod =>
    mod.dependencies.flatMap(dep => {
      const rule = rules[dep.dependency_type];
      if (rule === undefined) return [];
      const targets =
        dep.project_id === null
          ? byVersion.get(dep.version_id)
          : byProject.get(dep.project_id);
      return (targets ?? [])
        .filter(target => target !== mod)
        .flatMap(target => rule(mod, dep, target) ?? []);
    }),
  );
};

const duplicates = <T>(
  label: string,
  groups: ReadonlyMap<string, readonly T[]>,
  name: (item: T) => string,
): string[] =>
  [...groups].flatMap(([key, group]) =>
    group.length > 1
      ? [`${label} ${key} in ${group.map(name).join(', ')}`]
      : [],
  );

// Fabric's range syntax is not reimplemented, so only an any-version `breaks`
// is a certain load failure; ranged entries are reported unevaluated.
const anyVersion = (range: string): boolean => range === '*';

const declared = (
  jars: readonly FabricMod[],
  byId: ReadonlyMap<string, FabricMod[]>,
  kind: 'breaks' | 'conflicts',
  keep: (range: string) => boolean,
): string[] =>
  jars.flatMap(jar =>
    Object.entries(jar[kind])
      .filter(([, range]) => keep(range))
      .flatMap(([id, range]) =>
        (byId.get(id) ?? [])
          .filter(other => other !== jar)
          .map(other => `${jar.file} ${kind} ${id} ${range} (${other.file})`),
      ),
  );

// Fabric fails on duplicate ids and `breaks`; `conflicts` only logs a warning.
export const checkConflicts = (
  mods: readonly ResolvedVersion[],
  jars: readonly FabricMod[],
): { conflicts: string[]; warnings: string[] } => {
  const byProject = Map.groupBy(mods, mod => mod.project_id);
  const byId = Map.groupBy(jars, jar => jar.id);
  return {
    conflicts: [
      ...graphMessages(mods, byProject, conflictRules),
      ...duplicates('Modrinth project', byProject, mod => mod.path),
      ...duplicates('mod id', byId, jar => jar.file),
      ...declared(jars, byId, 'breaks', anyVersion),
    ],
    warnings: [
      ...graphMessages(mods, byProject, warningRules),
      ...declared(jars, byId, 'breaks', range => !anyVersion(range)),
      ...declared(jars, byId, 'conflicts', () => true),
    ],
  };
};
