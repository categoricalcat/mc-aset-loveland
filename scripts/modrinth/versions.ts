import type {
  File,
  ModrinthVersion,
  VersionDependency,
  VersionFile,
  VersionSource,
} from './types.js';

export interface Constraint {
  pins: Map<string, ConstraintSource[]>;
  projectId: string;
  root: null | { file: File; versionId: string };
  sources: ConstraintSource[];
}

export interface ConstraintSource {
  kind: 'required' | 'root';
  label: string;
  preserve: boolean;
  projectId: string;
  rootProjects: ReadonlySet<string>;
}

// 'unverified' keeps a root whose exported version or project is gone from
// Modrinth: assets, preserved mods, and gone-project roots alike.
export type ProjectSelection = 'drop' | 'unverified' | Selection;

export interface Selection {
  file: File;
  mode: 'asset' | 'preserved' | 'target';
  rootProjects: ReadonlySet<string>;
  version: ModrinthVersion;
}

// Assets are not loader code, so their pins on a known project never hold a
// mod back.
export const effectiveDependency = (
  dependency: VersionDependency,
  mode: Selection['mode'],
): VersionDependency =>
  mode === 'asset' &&
  dependency.dependency_type === 'required' &&
  dependency.project_id !== null
    ? { ...dependency, version_id: null }
    : dependency;

const sourceRootProjects = (
  sources: readonly ConstraintSource[],
): ReadonlySet<string> =>
  new Set(sources.flatMap(source => [...source.rootProjects]));

export class ResolutionError extends Error {
  readonly kind: 'conflict' | 'missing';
  readonly rootProjects: ReadonlySet<string>;
  readonly sources: readonly ConstraintSource[];

  constructor(
    kind: 'conflict' | 'missing',
    message: string,
    sources: readonly ConstraintSource[],
  ) {
    super(message);
    this.kind = kind;
    this.name = 'ResolutionError';
    this.sources = [...sources];
    this.rootProjects = sourceRootProjects(sources);
  }
}

export const missingBuildError = (
  projectId: null | string,
  versionId: null | string,
  sources: readonly ConstraintSource[],
): ResolutionError =>
  new ResolutionError(
    'missing',
    `no compatible build for ${
      versionId === null
        ? (projectId ?? 'an unidentified project')
        : `${projectId ?? 'version'}@${versionId}`
    }`,
    sources,
  );

export const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const sortedEntries = <V>(map: ReadonlyMap<string, V>): [string, V][] =>
  [...map].sort(([a], [b]) => compareStrings(a, b));

const isCompatible = (
  version: ModrinthVersion,
  game: string,
  loader: string,
): boolean =>
  version.game_versions.includes(game) && version.loaders.includes(loader);

const primaryFile = (version: ModrinthVersion): null | VersionFile =>
  version.files.find(file => file.primary) ?? version.files[0] ?? null;

export const rankedVersions = (
  versions: readonly ModrinthVersion[],
): ModrinthVersion[] =>
  [...versions].sort((left, right) => {
    const leftTime = Date.parse(left.date_published);
    const rightTime = Date.parse(right.date_published);
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    if (leftValid && rightValid && rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return (
      compareStrings(right.date_published, left.date_published) ||
      compareStrings(left.id, right.id)
    );
  });

export const newestRelease = (
  versions: readonly ModrinthVersion[],
): ModrinthVersion | null => {
  const newest = rankedVersions(versions);
  return (
    newest.find(version => version.version_type === 'release') ??
    newest[0] ??
    null
  );
};

const goneProjectError = (
  projectId: string,
  sources: readonly ConstraintSource[],
): ResolutionError =>
  new ResolutionError(
    'missing',
    `project ${projectId} no longer exists on Modrinth`,
    sources,
  );

// Null means the project itself is gone (404); an empty list means it exists
// but has no usable build for this game and loader.
export const compatibleVersions = async (
  projectId: string,
  game: string,
  loader: string,
  source: VersionSource,
): Promise<ModrinthVersion[] | null> => {
  const versions = await source.fetchProjectVersions({
    game,
    loaders: [loader],
    projectId,
  });
  return versions === null
    ? null
    : versions.filter(
        version =>
          isCompatible(version, game, loader) && primaryFile(version) !== null,
      );
};

export const fetchVerifiedVersion = async (
  source: VersionSource,
  versionId: string,
  expectedProjectId: null | string,
): Promise<ModrinthVersion | null> => {
  const version = await source.fetchVersionById(versionId);
  if (version === null) return null;
  if (version.id !== versionId) {
    throw new Error(
      `requested version ${versionId}, but received ${version.id}`,
    );
  }
  if (expectedProjectId !== null && version.project_id !== expectedProjectId) {
    throw new Error(
      `version ${versionId} for ${expectedProjectId} belongs to ${version.project_id}`,
    );
  }
  return version;
};

const indexFile = (versionFile: VersionFile, root: File | null): File => {
  const { filename } = versionFile;
  if (
    filename === '' ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new Error(`unsafe version filename: ${filename}`);
  }
  return {
    downloads: [versionFile.url],
    env: root?.env ?? { client: 'required', server: 'required' },
    fileSize: versionFile.size,
    hashes: versionFile.hashes,
    path: `${
      root === null
        ? 'mods/'
        : root.path.slice(0, root.path.lastIndexOf('/') + 1)
    }${filename}`,
  };
};

const preservedSelection = async (
  constraint: Constraint,
  versionId: string,
  source: VersionSource,
  mode: 'asset' | 'preserved',
): Promise<ProjectSelection> => {
  const version = await fetchVerifiedVersion(
    source,
    versionId,
    constraint.projectId,
  );
  // A gone pin keeps the exported file in every mode: deleting a working mod
  // because its metadata vanished is worse than shipping it unchecked.
  if (version === null) return 'unverified';
  const { root } = constraint;
  const rootProjects = sourceRootProjects(constraint.sources);
  if (root?.versionId === versionId) {
    return { file: root.file, mode, rootProjects, version };
  }
  const versionFile = primaryFile(version);
  if (versionFile === null) {
    throw new Error(
      `cannot preserve ${constraint.projectId}@${versionId}: no download`,
    );
  }
  return {
    file: indexFile(versionFile, root?.file ?? null),
    mode,
    rootProjects,
    version,
  };
};

// 'gone' is a missing project (404). A null version is a project that exists
// but has no usable build for this pin, game, and loader.
const chosenVersion = async (
  constraint: Constraint,
  game: string,
  loader: string,
  source: VersionSource,
  pin: string | undefined,
): Promise<'gone' | ModrinthVersion | null> => {
  if (pin !== undefined) {
    return fetchVerifiedVersion(source, pin, constraint.projectId);
  }
  const available = await compatibleVersions(
    constraint.projectId,
    game,
    loader,
    source,
  );
  return available === null ? 'gone' : newestRelease(available);
};

export const selectProjectVersion = async (
  constraint: Constraint,
  game: string,
  loader: string,
  source: VersionSource,
  preserveOriginalRoots: boolean,
): Promise<ProjectSelection> => {
  const pin = constraint.pins.keys().next().value;
  const targetReq = constraint.sources.some(
    s => s.kind === 'required' && !s.preserve,
  );
  const preservedReq = constraint.sources.some(
    s => s.kind === 'required' && s.preserve,
  );
  if (pin !== undefined && preservedReq && !targetReq) {
    return preservedSelection(constraint, pin, source, 'preserved');
  }
  const { root } = constraint;
  const version = await chosenVersion(constraint, game, loader, source, pin);
  // A gone project keeps its exported file; only a dep makes it fatal.
  if (version === 'gone') {
    if (root !== null) return 'unverified';
    throw goneProjectError(constraint.projectId, constraint.sources);
  }
  const file =
    version !== null && isCompatible(version, game, loader)
      ? primaryFile(version)
      : null;
  if (version !== null && file !== null) {
    return {
      file: indexFile(file, root?.file ?? null),
      mode: 'target',
      rootProjects: sourceRootProjects(constraint.sources),
      version,
    };
  }
  if (pin === undefined && !targetReq && root !== null) {
    if (preservedReq) {
      return preservedSelection(
        constraint,
        root.versionId,
        source,
        'preserved',
      );
    }
    if (!root.file.path.startsWith('mods/')) {
      return preservedSelection(constraint, root.versionId, source, 'asset');
    }
    return preserveOriginalRoots
      ? preservedSelection(constraint, root.versionId, source, 'preserved')
      : 'drop';
  }
  const failureSources =
    pin === undefined
      ? constraint.sources
      : preservedReq
        ? constraint.sources.filter(s => s.kind === 'required')
        : (constraint.pins.get(pin) ?? constraint.sources);
  throw missingBuildError(constraint.projectId, pin ?? null, failureSources);
};
