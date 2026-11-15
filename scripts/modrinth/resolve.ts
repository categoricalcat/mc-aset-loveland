import type {
  File,
  ModrinthVersion,
  ResolvedPackFile,
  ResolvedVersion,
  VersionSource,
} from './types.js';

import { parseModrinthDownload } from './api.js';
import { addConstraint, settleSelection } from './constraints.js';
import {
  compareStrings,
  compatibleVersions,
  type Constraint,
  effectiveDependency,
  newestRelease,
  type ProjectSelection,
  rankedVersions,
  ResolutionError,
  sortedEntries,
} from './versions.js';

const collectRoots = (
  files: readonly File[],
  rootVersions: ReadonlyMap<string, string>,
): { constraints: Map<string, Constraint>; unmanaged: ResolvedPackFile[] } => {
  const constraints = new Map<string, Constraint>();
  const unmanaged: ResolvedPackFile[] = [];
  for (const file of files) {
    const download = parseModrinthDownload(file.downloads[0]);
    if (download === null) {
      unmanaged.push({ file, preserve: true, projectId: null });
      continue;
    }
    const { projectId, versionId } = download;
    const constraint = addConstraint(
      constraints,
      projectId,
      {
        kind: 'root',
        label: `root ${file.path}`,
        preserve: false,
        projectId,
        rootProjects: new Set([projectId]),
      },
      rootVersions.get(projectId) ?? null,
    );
    if (constraint.root === null) {
      constraint.root = { file, versionId };
      continue;
    }
    const { root } = constraint;
    if (
      root.file.path !== file.path ||
      root.file.env.client !== file.env.client ||
      root.file.env.server !== file.env.server ||
      root.versionId !== versionId
    ) {
      throw new Error(
        `duplicate Modrinth project ${projectId}: ${root.file.path}, ${file.path}`,
      );
    }
  }
  return { constraints, unmanaged };
};

const assertUniqueFiles = (files: readonly ResolvedPackFile[]): void => {
  const paths = new Map<string, string>();
  const hashes = new Map<string, string>();
  for (const { file, projectId } of files) {
    const owner = projectId ?? `unmanaged ${file.path}`;
    const existingPath = paths.get(file.path);
    if (existingPath !== undefined) {
      throw new Error(
        `duplicate output path ${file.path}: ${existingPath}, ${owner}`,
      );
    }
    paths.set(file.path, owner);
    const existingHash = hashes.get(file.hashes.sha1);
    if (existingHash !== undefined) {
      throw new Error(
        `duplicate artifact sha1 ${file.hashes.sha1}: ${existingHash}, ${owner}`,
      );
    }
    hashes.set(file.hashes.sha1, owner);
  }
};

const resolvedPack = (
  constraints: ReadonlyMap<string, Constraint>,
  selected: ReadonlyMap<string, ProjectSelection>,
  unmanaged: readonly ResolvedPackFile[],
): {
  files: ResolvedPackFile[];
  issues: string[];
  resolved: Map<string, ResolvedVersion>;
  unresolved: string[];
} => {
  const files: ResolvedPackFile[] = [...unmanaged];
  const issues: string[] = [];
  const resolved = new Map<string, ResolvedVersion>();
  const unresolved: string[] = [];
  for (const [projectId, { root }] of sortedEntries(constraints)) {
    const selection = selected.get(projectId);
    if (selection === undefined) {
      throw new Error(`missing selection for ${projectId}`);
    }
    if (typeof selection !== 'string') {
      files.push({
        file: selection.file,
        preserve: selection.mode !== 'target',
        projectId,
      });
      resolved.set(projectId, {
        dependencies: selection.version.dependencies.map(dependency =>
          effectiveDependency(dependency, selection.mode),
        ),
        id: selection.version.id,
        path: selection.file.path,
        project_id: projectId,
      });
      continue;
    }
    if (root === null) continue;
    if (selection === 'drop') {
      unresolved.push(root.file.path);
    } else {
      files.push({ file: root.file, preserve: true, projectId });
      issues.push(
        `${root.file.path}: exported version ${root.versionId} is unavailable on Modrinth; kept as exported without dependency checks`,
      );
    }
  }
  files.sort((a, b) => compareStrings(a.file.path, b.file.path));
  unresolved.sort(compareStrings);
  assertUniqueFiles(files);
  return { files, issues, resolved, unresolved };
};

const rootVersionSignature = (roots: ReadonlyMap<string, string>): string =>
  JSON.stringify(sortedEntries(roots));

const fallbackRootStates = async (
  projects: ReadonlySet<string>,
  rootVersions: ReadonlyMap<string, string>,
  roots: ReadonlyMap<string, Constraint>,
  game: string,
  loader: string,
  source: VersionSource,
  cachedVersions: Map<string, ModrinthVersion[]>,
): Promise<Map<string, string>[]> => {
  const states: Map<string, string>[] = [];
  const currentSignature = rootVersionSignature(rootVersions);
  for (const projectId of [...projects].sort(compareStrings)) {
    if (!roots.has(projectId)) continue;
    // A gone project (null) has no fallback versions to try.
    const versions =
      cachedVersions.get(projectId) ??
      (await compatibleVersions(projectId, game, loader, source)) ??
      [];
    cachedVersions.set(projectId, versions);
    const defaultVersionId = newestRelease(versions)?.id;
    const ranked = rankedVersions(versions);
    const releases = ranked.filter(v => v.version_type === 'release');
    for (const version of releases.length > 0 ? releases : ranked) {
      const next = new Map(rootVersions);
      if (version.id === defaultVersionId) next.delete(projectId);
      else next.set(projectId, version.id);
      if (rootVersionSignature(next) !== currentSignature) states.push(next);
    }
  }
  return states;
};

const MAX_ROOT_VERSION_ATTEMPTS = 128;

/**
 * Shapes exported index files as ResolvedVersion for conflict checks without
 * re-resolving. Non-Modrinth files and versions deleted since export are
 * skipped, matching how update treats unresolvable files. Assets keep the
 * same dependency downgrade the resolver applies outside mods/.
 */
export const exportedResolvedVersions = async (
  files: readonly File[],
  fetchVersionById: VersionSource['fetchVersionById'],
): Promise<Map<string, ResolvedVersion>> => {
  const resolved = new Map<string, ResolvedVersion>();
  for (const file of files) {
    const download = parseModrinthDownload(file.downloads[0]);
    if (download === null || resolved.has(download.projectId)) continue;
    const version = await fetchVersionById(download.versionId);
    if (version === null) {
      console.warn(
        `  Exported version ${download.versionId} of ${file.path} is gone from Modrinth; skipped in conflict checks`,
      );
      continue;
    }
    resolved.set(download.projectId, {
      dependencies: version.dependencies.map(dependency =>
        effectiveDependency(
          dependency,
          file.path.startsWith('mods/') ? 'target' : 'asset',
        ),
      ),
      id: version.id,
      path: file.path,
      project_id: download.projectId,
    });
  }
  return resolved;
};

export const resolvePackFiles = async (
  files: readonly File[],
  game: string,
  loader: string,
  source: VersionSource,
  preserveOriginalRoots = false,
): Promise<{
  files: ResolvedPackFile[];
  issues: string[];
  resolved: Map<string, ResolvedVersion>;
  unresolved: string[];
}> => {
  let attempts = 0;
  const candidates = new Map<string, ModrinthVersion[]>();
  const queued = new Set<string>(['[]']);
  const queue = [new Map<string, string>()];
  const implicatedRoots = new Set<string>();
  let initialFailure: null | ResolutionError = null;

  while (queue.length > 0 && attempts < MAX_ROOT_VERSION_ATTEMPTS) {
    const rootVersions = queue.shift();
    if (rootVersions === undefined) break;
    attempts += 1;
    const roots = collectRoots(files, rootVersions);
    try {
      const selection = await settleSelection(
        roots.constraints,
        game,
        loader,
        source,
        preserveOriginalRoots,
      );
      return resolvedPack(
        selection.constraints,
        selection.selected,
        roots.unmanaged,
      );
    } catch (caught) {
      if (!(caught instanceof ResolutionError)) throw caught;
      initialFailure ??= caught;
      for (const id of caught.rootProjects) implicatedRoots.add(id);
      for (const state of await fallbackRootStates(
        caught.rootProjects,
        rootVersions,
        roots.constraints,
        game,
        loader,
        source,
        candidates,
      )) {
        const sig = rootVersionSignature(state);
        if (!queued.has(sig)) {
          queued.add(sig);
          queue.push(state);
        }
      }
    }
  }

  if (initialFailure === null) {
    throw new Error('root-version fallback did not produce a resolution');
  }
  const projects = [...implicatedRoots].sort(compareStrings).join(', ');
  const outcome =
    attempts === MAX_ROOT_VERSION_ATTEMPTS && queue.length > 0
      ? 'root-version fallback search limit reached'
      : initialFailure.kind === 'conflict'
        ? 'no compatible root-version combination found'
        : 'no compatible root version avoids it';
  throw new Error(
    `${initialFailure.message}; ${outcome}. Replace or remove: ${projects}`,
    { cause: initialFailure },
  );
};
