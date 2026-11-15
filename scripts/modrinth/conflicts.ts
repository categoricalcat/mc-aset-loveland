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

const warningRules: Rules = {
  embedded: (mod, _dep, target) =>
    `${mod.path} embeds ${target.path}, also shipped as its own file`,
};

const versionRange = (value: Json | undefined): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.filter(item => typeof item === 'string').join(' || ')
      : '*';

const dependencyTargets = (
  dep: VersionDependency,
  byProject: ReadonlyMap<string, ResolvedVersion[]>,
  byVersion: ReadonlyMap<null | string, ResolvedVersion[]>,
): readonly ResolvedVersion[] =>
  (dep.project_id === null
    ? byVersion.get(dep.version_id)
    : byProject.get(dep.project_id)) ?? [];

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
  byVersion: ReadonlyMap<null | string, ResolvedVersion[]>,
  rules: Rules,
): string[] => {
  return mods.flatMap(mod =>
    mod.dependencies.flatMap(dep => {
      const rule = rules[dep.dependency_type];
      if (rule === undefined) return [];
      return dependencyTargets(dep, byProject, byVersion)
        .filter(target => target !== mod)
        .flatMap(target => rule(mod, dep, target) ?? []);
    }),
  );
};

const isUnidentified = (dep: VersionDependency): boolean =>
  dep.dependency_type === 'required' &&
  dep.project_id === null &&
  dep.version_id === null;

// Missing required deps are fatal only for mods: the game enforces mod
// dependencies at launch, while resource/shader pack deps are launcher hints.
const isModPath = (path: string): boolean =>
  path.startsWith('mods/') || path.startsWith('overrides/mods/');

const requiredMessages = (
  mods: readonly ResolvedVersion[],
  byProject: ReadonlyMap<string, ResolvedVersion[]>,
  byVersion: ReadonlyMap<null | string, ResolvedVersion[]>,
  skipped: ReadonlyMap<string, string>,
  skippedVersions: ReadonlyMap<null | string, string>,
): { conflicts: string[]; warnings: string[] } => {
  const conflicts: string[] = [];
  const warnings: string[] = [];
  for (const mod of mods) {
    for (const dep of mod.dependencies) {
      if (dep.dependency_type !== 'required' || isUnidentified(dep)) continue;
      const targets = dependencyTargets(dep, byProject, byVersion);
      if (targets.length === 0) {
        const label = dep.project_id ?? `version ${dep.version_id}`;
        const reason =
          dep.project_id === null
            ? skippedVersions.get(dep.version_id)
            : skipped.get(dep.project_id);
        const message = `${mod.path} requires ${label}, but ${reason ?? 'it is missing'}`;
        (reason === undefined && isModPath(mod.path)
          ? conflicts
          : warnings
        ).push(message);
        continue;
      }
      // A pinned version id is release metadata, not a semver range; shipping
      // a different version of the project usually still loads fine.
      if (
        dep.version_id !== null &&
        !targets.some(target => target.id === dep.version_id)
      ) {
        warnings.push(
          `${mod.path} requires version ${dep.version_id} of ${dep.project_id ?? 'an external project'}`,
        );
      }
    }
  }
  return { conflicts, warnings };
};

export const missingRequiredProjects = (
  mods: readonly ResolvedVersion[],
): string[] => {
  const byProject = Map.groupBy(mods, mod => mod.project_id);
  return [
    ...new Set(
      mods.flatMap(mod =>
        mod.dependencies.flatMap(dep =>
          dep.dependency_type === 'required' &&
          dep.project_id !== null &&
          !byProject.has(dep.project_id)
            ? [dep.project_id]
            : [],
        ),
      ),
    ),
  ];
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
  skipped: ReadonlyMap<string, string> = new Map(),
  skippedVersions: ReadonlyMap<null | string, string> = new Map(),
): { conflicts: string[]; errors: string[]; warnings: string[] } => {
  const byProject = Map.groupBy(mods, mod => mod.project_id);
  const byVersion = Map.groupBy<null | string, ResolvedVersion>(
    mods,
    mod => mod.id,
  );
  const byId = Map.groupBy(jars, jar => jar.id);
  const required = requiredMessages(
    mods,
    byProject,
    byVersion,
    skipped,
    skippedVersions,
  );
  return {
    conflicts: [
      ...graphMessages(mods, byProject, byVersion, conflictRules),
      ...required.conflicts,
      ...duplicates('Modrinth project', byProject, mod => mod.path),
      ...duplicates('mod id', byId, jar => jar.file),
      ...declared(jars, byId, 'breaks', anyVersion),
    ],
    errors: mods.flatMap(mod =>
      mod.dependencies.some(isUnidentified)
        ? [
            `${mod.path} requires a dependency with no Modrinth project or version id; not checked`,
          ]
        : [],
    ),
    warnings: [
      ...graphMessages(mods, byProject, byVersion, warningRules),
      ...required.warnings,
      ...declared(jars, byId, 'breaks', range => !anyVersion(range)),
      ...declared(jars, byId, 'conflicts', () => true),
    ],
  };
};
