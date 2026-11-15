import type { VersionDependency, VersionSource } from './types.js';

import {
  compareStrings,
  type Constraint,
  type ConstraintSource,
  effectiveDependency,
  fetchVerifiedVersion,
  missingBuildError,
  type ProjectSelection,
  ResolutionError,
  type Selection,
  selectProjectVersion,
  sortedEntries,
} from './versions.js';

interface StableSelection {
  constraints: Map<string, Constraint>;
  selected: Map<string, ProjectSelection>;
}

export const addConstraint = (
  constraints: Map<string, Constraint>,
  projectId: string,
  source: ConstraintSource,
  versionId: null | string,
): Constraint => {
  const constraint: Constraint = constraints.get(projectId) ?? {
    pins: new Map<string, ConstraintSource[]>(),
    projectId,
    root: null,
    sources: [],
  };
  constraint.sources.push(source);
  if (versionId !== null) {
    const sources = constraint.pins.get(versionId) ?? [];
    sources.push(source);
    constraint.pins.set(versionId, sources);
  }
  constraints.set(projectId, constraint);
  return constraint;
};

const addDependency = async (
  constraints: Map<string, Constraint>,
  dependency: VersionDependency,
  parent: Selection,
  source: VersionSource,
): Promise<void> => {
  if (dependency.dependency_type !== 'required') return;
  const parentSource: ConstraintSource = {
    kind: 'required',
    label: `${parent.version.project_id}@${parent.version.id}`,
    preserve: parent.mode === 'preserved',
    projectId: parent.version.project_id,
    rootProjects: parent.rootProjects,
  };
  if (dependency.version_id === null) {
    // External dependencies have no ids; checkConflicts reports them instead.
    if (dependency.project_id !== null) {
      addConstraint(constraints, dependency.project_id, parentSource, null);
    }
    return;
  }
  const version = await fetchVerifiedVersion(
    source,
    dependency.version_id,
    dependency.project_id,
  );
  if (version === null) {
    throw missingBuildError(dependency.project_id, dependency.version_id, [
      parentSource,
    ]);
  }
  addConstraint(constraints, version.project_id, parentSource, version.id);
};

const selectionKey = (selection: ProjectSelection | undefined): string =>
  selection === undefined || typeof selection === 'string'
    ? String(selection)
    : `${selection.version.id}:${selection.mode}`;

const selectionSignature = (
  selected: ReadonlyMap<string, ProjectSelection>,
): string =>
  JSON.stringify(
    [...selected].map(([id, selection]) => [id, selectionKey(selection)]),
  );

const propagateDependencies = async (
  roots: ReadonlyMap<string, Constraint>,
  selected: ReadonlyMap<string, ProjectSelection>,
  source: VersionSource,
): Promise<{
  constraints: Map<string, Constraint>;
  failures: ResolutionError[];
}> => {
  const constraints = new Map<string, Constraint>();
  for (const [id, c] of roots) {
    constraints.set(id, {
      ...c,
      pins: new Map([...c.pins].map(([v, s]) => [v, [...s]])),
      sources: [...c.sources],
    });
  }
  const failures: ResolutionError[] = [];
  const edges = [...selected.values()].flatMap(s =>
    typeof s === 'string'
      ? []
      : s.version.dependencies.map(
          d => [s, effectiveDependency(d, s.mode)] as const,
        ),
  );
  for (const [selection, dependency] of edges) {
    try {
      await addDependency(constraints, dependency, selection, source);
    } catch (caught) {
      if (caught instanceof ResolutionError) failures.push(caught);
      else throw caught;
    }
  }
  for (const [, c] of sortedEntries(constraints)) {
    if (c.pins.size > 1) {
      const details = sortedEntries(c.pins)
        .map(
          ([id, s]) =>
            `${id} (${s
              .map(item => item.label)
              .sort(compareStrings)
              .join(', ')})`,
        )
        .join('; ');
      failures.push(
        new ResolutionError(
          'conflict',
          `conflicting required versions for ${c.projectId}: ${details}`,
          [...c.pins.values()].flat(),
        ),
      );
    }
  }
  return { constraints, failures };
};

const oscillationError = (
  constraints: ReadonlyMap<string, Constraint>,
  cycle: readonly ReadonlyMap<string, ProjectSelection>[],
): ResolutionError => {
  const varying = sortedEntries(constraints).flatMap(([id, c]) =>
    new Set(cycle.map(state => selectionKey(state.get(id)))).size > 1
      ? [c]
      : [],
  );
  return new ResolutionError(
    'conflict',
    `dependency versions do not converge for ${varying.map(c => c.projectId).join(', ')}`,
    varying.flatMap(c => c.sources),
  );
};

export const settleSelection = async (
  roots: ReadonlyMap<string, Constraint>,
  game: string,
  loader: string,
  source: VersionSource,
  preserveOriginalRoots: boolean,
): Promise<StableSelection> => {
  let selected = new Map<string, ProjectSelection>();
  let prevSignature = selectionSignature(selected);
  const history = [selected];
  const seen = new Map([[prevSignature, 0]]);
  for (;;) {
    const { constraints, failures } = await propagateDependencies(
      roots,
      selected,
      source,
    );
    const next = new Map<string, ProjectSelection>();
    for (const [id, c] of sortedEntries(constraints)) {
      if (c.pins.size > 1) continue;
      try {
        next.set(
          id,
          await selectProjectVersion(
            c,
            game,
            loader,
            source,
            preserveOriginalRoots,
          ),
        );
      } catch (caught) {
        if (caught instanceof ResolutionError) failures.push(caught);
        else throw caught;
      }
    }
    const failure = failures.find(item =>
      item.sources.every(
        s =>
          s.kind === 'root' ||
          selectionKey(selected.get(s.projectId)) ===
            selectionKey(next.get(s.projectId)),
      ),
    );
    if (failure !== undefined) throw failure;
    const signature = selectionSignature(next);
    if (signature === prevSignature) return { constraints, selected: next };
    const cycleStart = seen.get(signature);
    if (cycleStart !== undefined) {
      throw oscillationError(constraints, history.slice(cycleStart));
    }
    seen.set(signature, history.length);
    history.push(next);
    prevSignature = signature;
    selected = next;
  }
};
