import { deepEqual, rejects, strictEqual } from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkConflicts,
  exportedResolvedVersions,
  type File,
  type ModrinthVersion,
  resolvePackFiles,
  type VersionDependency,
  type VersionSource,
} from './index.js';

interface VersionOptions {
  date?: string;
  dependencies?: ModrinthVersion['dependencies'];
  download?: boolean;
  gameVersions?: string[];
  id: string;
  loaders?: string[];
  projectId: string;
  sha1?: string;
}

const version = ({
  date = '2026-01-01T00:00:00.000Z',
  dependencies = [],
  download = true,
  gameVersions = ['26.3'],
  id,
  loaders = ['fabric'],
  projectId,
  sha1 = `sha1-${id}`,
}: VersionOptions): ModrinthVersion => ({
  date_published: date,
  dependencies,
  files: download
    ? [
        {
          filename: `${projectId}-${id}.jar`,
          hashes: { sha1, sha512: `sha512-${id}` },
          primary: true,
          size: 1,
          url: `https://cdn.modrinth.com/data/${projectId}/versions/${id}/${projectId}-${id}.jar`,
        },
      ]
    : [],
  game_versions: gameVersions,
  id,
  loaders,
  project_id: projectId,
  version_number: id,
  version_type: 'release',
});

const root = (
  projectId: string,
  path = `mods/${projectId}.jar`,
  versionId = `old-${projectId}`,
): File => ({
  downloads: [
    `https://cdn.modrinth.com/data/${projectId}/versions/${versionId}/${projectId}.jar`,
  ],
  env: { client: 'required', server: 'required' },
  fileSize: 1,
  hashes: { sha1: `root-${projectId}`, sha512: `root-${projectId}` },
  path,
});

const source = (versions: readonly ModrinthVersion[]): VersionSource => {
  const byId = new Map(versions.map(item => [item.id, item]));
  const byProject = Map.groupBy(versions, item => item.project_id);
  return {
    fetchProjectVersions: ({ projectId }) =>
      Promise.resolve(byProject.get(projectId) ?? []),
    fetchVersionById: versionId => Promise.resolve(byId.get(versionId) ?? null),
  };
};

const resolve = (
  files: readonly File[],
  versions: readonly ModrinthVersion[],
  preserveOriginalRoots = false,
) =>
  resolvePackFiles(
    files,
    '26.3',
    'fabric',
    source(versions),
    preserveOriginalRoots,
  );

const requires = (
  projectId: null | string,
  versionId: null | string = null,
): VersionDependency => ({
  dependency_type: 'required',
  project_id: projectId,
  version_id: versionId,
});

const ids = (
  result: Awaited<ReturnType<typeof resolve>>,
): Record<string, string> =>
  Object.fromEntries(
    [...result.resolved].map(([projectId, resolved]) => [
      projectId,
      resolved.id,
    ]),
  );

void test('falls back when dependency versions oscillate', async () => {
  const versions = [
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('b', 'b-old')],
      id: 'a-new',
      projectId: 'a',
    }),
    version({ id: 'a-old', projectId: 'a' }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      id: 'b-new',
      projectId: 'b',
    }),
    version({
      dependencies: [requires('a', 'a-old')],
      id: 'b-old',
      projectId: 'b',
    }),
  ];

  const result = await resolve([root('a'), root('b')], versions);

  deepEqual(ids(result), { a: 'a-old', b: 'b-new' });
});

void test('skips a required dependency with no Modrinth id and reports it', async () => {
  const versions = [
    version({ dependencies: [requires(null)], id: 'app-1', projectId: 'app' }),
  ];

  const result = await resolve([root('app')], versions);
  const { conflicts, errors } = checkConflicts(
    [...result.resolved.values()],
    [],
  );

  deepEqual(ids(result), { app: 'app-1' });
  deepEqual(conflicts, []);
  deepEqual(errors, [
    'mods/app-app-1.jar requires a dependency with no Modrinth project or version id; not checked',
  ]);
});

void test('updates exact mod pins of preserved assets instead of failing', async () => {
  const versions = [
    version({
      dependencies: [requires('iris', 'iris-old')],
      gameVersions: ['26.2'],
      id: 'shader-old',
      loaders: ['iris'],
      projectId: 'shader',
    }),
    version({ gameVersions: ['26.2'], id: 'iris-old', projectId: 'iris' }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      id: 'iris-new',
      projectId: 'iris',
    }),
  ];

  const result = await resolve(
    [root('shader', 'shaderpacks/shader.zip', 'shader-old')],
    versions,
  );

  deepEqual(ids(result), { iris: 'iris-new', shader: 'shader-old' });
  deepEqual(checkConflicts([...result.resolved.values()], []).conflicts, []);
});

void test('keeps an asset whose exported version is gone from Modrinth', async () => {
  const shader = root('shader', 'shaderpacks/shader.zip', 'shader-deleted');

  const result = await resolve([shader], []);

  deepEqual(result.files, [
    { file: shader, preserve: true, projectId: 'shader' },
  ]);
  deepEqual(ids(result), {});
  deepEqual(result.issues, [
    'shaderpacks/shader.zip: exported version shader-deleted is unavailable on Modrinth; kept as exported without dependency checks',
  ]);
});

void test('uses an exact required pin instead of the newest project release', async () => {
  const versions = [
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('library', 'library-1')],
      id: 'app-1',
      projectId: 'app',
    }),
    version({
      date: '2026-03-01T00:00:00.000Z',
      id: 'library-2',
      projectId: 'library',
    }),
    version({
      id: 'library-1',
      projectId: 'library',
    }),
  ];

  const result = await resolve([root('app')], versions);

  strictEqual(result.resolved.get('library')?.id, 'library-1');
});

void test('rejects conflicting exact pins with their project', async () => {
  const versions = [
    version({
      dependencies: [requires('library', 'library-1')],
      id: 'app-a',
      projectId: 'app-a',
    }),
    version({
      dependencies: [requires('library', 'library-2')],
      id: 'app-b',
      projectId: 'app-b',
    }),
    version({ id: 'library-1', projectId: 'library' }),
    version({ id: 'library-2', projectId: 'library' }),
  ];

  await rejects(
    resolve([root('app-a'), root('app-b')], versions),
    /no compatible root-version combination found\. Replace or remove: app-a, app-b/,
  );
});

void test('chooses a compatible root-version combination for exact-pin conflicts', async () => {
  const appA = root('app-a');
  const appB = root('app-b');
  const library = root('library');
  const versions = [
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('library', 'library-1')],
      id: 'app-a-new',
      projectId: 'app-a',
    }),
    version({
      dependencies: [requires('library', 'old-library')],
      id: 'old-app-a',
      projectId: 'app-a',
    }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('library', 'library-2')],
      id: 'app-b-new',
      projectId: 'app-b',
    }),
    version({
      dependencies: [requires('library', 'old-library')],
      id: 'old-app-b',
      projectId: 'app-b',
    }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      id: 'library-1',
      projectId: 'library',
    }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      id: 'library-2',
      projectId: 'library',
    }),
    version({ id: 'old-library', projectId: 'library' }),
  ];

  const result = await resolve([appA, appB, library], versions);

  deepEqual(ids(result), {
    'app-a': 'old-app-a',
    'app-b': 'old-app-b',
    library: 'old-library',
  });
  deepEqual(
    result.files.map(item => item.preserve),
    [false, false, false],
  );
});

void test('chooses a root version that avoids an unavailable required dependency', async () => {
  const versions = [
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('missing')],
      id: 'app-new',
      projectId: 'app',
    }),
    version({ id: 'app-old', projectId: 'app' }),
  ];

  const result = await resolve([root('app')], versions);

  strictEqual(result.resolved.get('app')?.id, 'app-old');
  strictEqual(result.resolved.has('missing'), false);
});

void test('names roots that must be replaced when no fallback avoids a missing dependency', async () => {
  const versions = [
    version({
      dependencies: [requires('missing')],
      id: 'app-1',
      projectId: 'app',
    }),
  ];

  await rejects(
    resolve([root('app')], versions),
    /no compatible root version avoids it\. Replace or remove: app/,
  );
});

void test('removes dependencies belonging only to a superseded version', async () => {
  const versions = [
    version({
      date: '2026-03-01T00:00:00.000Z',
      dependencies: [requires('transient')],
      id: 'app-new',
      projectId: 'app',
    }),
    version({
      date: '2026-01-01T00:00:00.000Z',
      id: 'app-old',
      projectId: 'app',
    }),
    version({
      dependencies: [requires('app', 'app-old')],
      id: 'pin-app',
      projectId: 'pin',
    }),
    version({ id: 'transient-1', projectId: 'transient' }),
  ];

  const result = await resolve([root('app'), root('pin')], versions);

  strictEqual(result.resolved.get('app')?.id, 'app-old');
  strictEqual(result.resolved.has('transient'), false);
});

void test('resolves a version-only required dependency', async () => {
  const versions = [
    version({
      dependencies: [requires(null, 'library-1')],
      id: 'app-1',
      projectId: 'app',
    }),
    version({ id: 'library-1', projectId: 'library' }),
  ];

  const result = await resolve([root('app')], versions);

  strictEqual(result.resolved.get('library')?.id, 'library-1');
});

void test('rejects a pin whose version belongs to another project', async () => {
  const versions = [
    version({
      dependencies: [requires('library', 'other-1')],
      id: 'app-1',
      projectId: 'app',
    }),
    version({ id: 'other-1', projectId: 'other' }),
  ];

  await rejects(resolve([root('app')], versions), /belongs to other/);
});

void test('rejects a fetched version that does not match its requested ID', async () => {
  const app = version({
    dependencies: [requires('library', 'library-1')],
    id: 'app-1',
    projectId: 'app',
  });
  const wrongVersion = version({ id: 'wrong-id', projectId: 'library' });
  const versionSource: VersionSource = {
    fetchProjectVersions: ({ projectId }) =>
      Promise.resolve(projectId === 'app' ? [app] : []),
    fetchVersionById: () => Promise.resolve(wrongVersion),
  };

  await rejects(
    resolvePackFiles([root('app')], '26.3', 'fabric', versionSource),
    /requested version library-1, but received wrong-id/,
  );
});

void test('reports roots when no fallback avoids an unsupported exact pin', async () => {
  const versions = [
    version({
      dependencies: [requires('library', 'library-old')],
      id: 'app-1',
      projectId: 'app',
    }),
    version({
      gameVersions: ['26.2'],
      id: 'library-old',
      projectId: 'library',
    }),
  ];

  await rejects(
    resolve([root('app')], versions),
    /no compatible root version avoids it\. Replace or remove: app/,
  );
});

void test('falls back when an exact pin is missing, unsupported, or undownloadable', async () => {
  const appNew = version({
    date: '2026-02-01T00:00:00.000Z',
    dependencies: [requires('library', 'library-target')],
    id: 'app-new',
    projectId: 'app',
  });
  const appOld = version({ id: 'app-old', projectId: 'app' });
  const targets = [
    [],
    [
      version({
        gameVersions: ['26.2'],
        id: 'library-target',
        projectId: 'library',
      }),
    ],
    [
      version({
        download: false,
        id: 'library-target',
        projectId: 'library',
      }),
    ],
  ];

  for (const target of targets) {
    const result = await resolve([root('app')], [appNew, appOld, ...target]);
    strictEqual(result.resolved.get('app')?.id, 'app-old');
  }
});

void test('retracts stale dependencies before reporting a missing build', async () => {
  const versions = [
    version({
      dependencies: [requires('app')],
      id: 'top-a-1',
      projectId: 'top-a',
    }),
    version({
      dependencies: [requires('bridge')],
      id: 'top-b-1',
      projectId: 'top-b',
    }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('missing')],
      id: 'app-new',
      projectId: 'app',
    }),
    version({ id: 'app-old', projectId: 'app' }),
    version({
      dependencies: [requires('app', 'app-old')],
      id: 'bridge-1',
      projectId: 'bridge',
    }),
  ];

  const result = await resolve([root('top-a'), root('top-b')], versions);

  strictEqual(result.resolved.get('app')?.id, 'app-old');
  strictEqual(result.resolved.has('missing'), false);
});

void test('falls back through transitive dependency ancestry', async () => {
  const versions = [
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('helper')],
      id: 'top-new',
      projectId: 'top',
    }),
    version({ id: 'top-old', projectId: 'top' }),
    version({
      dependencies: [requires('missing')],
      id: 'helper-1',
      projectId: 'helper',
    }),
  ];

  const result = await resolve([root('top')], versions);

  strictEqual(result.resolved.get('top')?.id, 'top-old');
  strictEqual(result.resolved.has('helper'), false);
});

void test('finds a conflict fallback with version-only dependencies', async () => {
  const versions = [
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('library', 'library-1')],
      id: 'a-new',
      projectId: 'a',
    }),
    version({
      dependencies: [requires(null, 'library-2')],
      id: 'a-old',
      projectId: 'a',
    }),
    version({
      dependencies: [requires('library', 'library-2')],
      id: 'b-1',
      projectId: 'b',
    }),
    version({ id: 'library-1', projectId: 'library' }),
    version({ id: 'library-2', projectId: 'library' }),
  ];

  const result = await resolve([root('a'), root('b')], versions);

  strictEqual(result.resolved.get('a')?.id, 'a-old');
  strictEqual(result.resolved.get('library')?.id, 'library-2');
});

void test('keeps preserved dependency components in resolved conflict membership', async () => {
  const app = root('app', 'mods/app.jar', 'app-original');
  const library = root('library', 'mods/library.jar', 'library-original');
  const versions = [
    version({
      dependencies: [requires('library', 'library-original')],
      gameVersions: ['26.2'],
      id: 'app-original',
      projectId: 'app',
    }),
    version({
      gameVersions: ['26.2'],
      id: 'library-original',
      projectId: 'library',
    }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      id: 'library-new',
      projectId: 'library',
    }),
  ];

  const result = await resolve([app, library], versions, true);
  const conflicts = checkConflicts(
    [
      ...result.resolved.values(),
      {
        dependencies: [],
        id: 'override-app',
        path: 'overrides/mods/app.jar',
        project_id: 'app',
      },
    ],
    [],
  ).conflicts;

  strictEqual(result.resolved.get('app')?.id, 'app-original');
  strictEqual(result.resolved.get('library')?.id, 'library-original');
  deepEqual(
    result.files.map(item => item.preserve),
    [true, true],
  );
  deepEqual(conflicts, [
    'Modrinth project app in mods/app.jar, overrides/mods/app.jar',
  ]);
});

void test('rejects a mismatched fallback root-version lookup', async () => {
  const appNew = version({
    dependencies: [requires('missing')],
    id: 'app-new',
    projectId: 'app',
  });
  const appOld = version({ id: 'app-old', projectId: 'app' });
  const versionSource: VersionSource = {
    fetchProjectVersions: ({ projectId }) =>
      Promise.resolve(projectId === 'app' ? [appNew, appOld] : []),
    fetchVersionById: versionId =>
      Promise.resolve(versionId === 'app-old' ? appNew : null),
  };

  await rejects(
    resolvePackFiles([root('app')], '26.3', 'fabric', versionSource),
    /requested version app-old, but received app-new/,
  );
});

void test('retains unmanaged roots as exported', async () => {
  const unmanaged: File = {
    ...root('unmanaged'),
    downloads: ['https://example.invalid/custom.jar'],
  };

  const result = await resolve([unmanaged], []);

  deepEqual(result.files, [
    { file: unmanaged, preserve: true, projectId: null },
  ]);
});

void test('drops or preserves a mod with no compatible build by mode', async () => {
  const missing = root('missing');
  const missingVersion = version({
    gameVersions: ['26.2'],
    id: 'old-missing',
    projectId: 'missing',
  });
  const dropped = await resolve([missing], [missingVersion]);
  const preserved = await resolve([missing], [missingVersion], true);

  deepEqual(dropped.files, []);
  deepEqual(dropped.unresolved, ['mods/missing.jar']);
  deepEqual(preserved.files, [
    { file: missing, preserve: true, projectId: 'missing' },
  ]);
  deepEqual(preserved.unresolved, []);
});

void test('drops a mod whose only build has no download', async () => {
  const noDownloadVersion = version({
    download: false,
    id: 'old-no-download',
    projectId: 'no-download',
  });

  const result = await resolve([root('no-download')], [noDownloadVersion]);

  deepEqual(result.files, []);
  deepEqual(result.unresolved, ['mods/no-download.jar']);
});

void test('fails to preserve a mod whose exported version is gone', async () => {
  await rejects(
    resolve([root('unknown')], [], true),
    /cannot preserve unknown: version old-unknown is unavailable/,
  );
});

void test('rejects distinct root paths for the same Modrinth project', async () => {
  await rejects(
    resolve(
      [root('app', 'mods/app.jar'), root('app', 'mods/app-copy.jar')],
      [],
    ),
    /duplicate Modrinth project app/,
  );
});

void test('is invariant under root order and idempotent on canonical output', async () => {
  const versions = [
    version({
      dependencies: [requires('library')],
      id: 'app-a',
      projectId: 'app-a',
    }),
    version({
      dependencies: [requires('library')],
      id: 'app-b',
      projectId: 'app-b',
    }),
    version({ id: 'library-1', projectId: 'library' }),
  ];

  const first = await resolve([root('app-a'), root('app-b')], versions);
  const reordered = await resolve([root('app-b'), root('app-a')], versions);
  const second = await resolve(
    first.files.map(item => item.file),
    versions,
  );
  deepEqual(ids(first), ids(reordered));
  deepEqual(ids(second), ids(first));
});

void test('shapes exported files as resolved versions for conflict checks', async () => {
  const files = [
    root('app', 'mods/app.jar', 'app-1'),
    root('shader', 'shaderpacks/shader.zip', 'shader-1'),
    { ...root('custom'), downloads: ['https://example.invalid/custom.jar'] },
  ];
  const versions = [
    version({
      dependencies: [requires('library', 'library-1')],
      id: 'app-1',
      projectId: 'app',
    }),
    version({
      dependencies: [requires('library', 'library-1')],
      id: 'shader-1',
      loaders: ['iris'],
      projectId: 'shader',
    }),
  ];

  const resolved = await exportedResolvedVersions(
    files,
    source(versions).fetchVersionById,
  );

  deepEqual(resolved.get('app')?.dependencies, [
    requires('library', 'library-1'),
  ]);
  deepEqual(resolved.get('shader')?.dependencies, [
    { dependency_type: 'required', project_id: 'library', version_id: null },
  ]);
  strictEqual(resolved.get('app')?.path, 'mods/app.jar');
  strictEqual(resolved.has('custom'), false);
});

void test('skips exported versions gone from Modrinth', async () => {
  const resolved = await exportedResolvedVersions(
    [root('app')],
    source([]).fetchVersionById,
  );

  strictEqual(resolved.size, 0);
});

void test('keeps an explicitly listed library when another mod embeds it', () => {
  const { conflicts, warnings } = checkConflicts(
    [
      {
        dependencies: [
          {
            dependency_type: 'embedded',
            project_id: 'library',
            version_id: null,
          },
        ],
        id: 'app-1',
        path: 'mods/app.jar',
        project_id: 'app',
      },
      {
        dependencies: [],
        id: 'library-1',
        path: 'mods/library.jar',
        project_id: 'library',
      },
    ],
    [],
  );

  deepEqual(conflicts, []);
  deepEqual(warnings, [
    'mods/app.jar embeds mods/library.jar, also shipped as its own file',
  ]);
});

void test('reports missing required dependencies from known override metadata', () => {
  const conflicts = checkConflicts(
    [
      {
        dependencies: [requires('library')],
        id: 'override-1',
        path: 'overrides/mods/override.jar',
        project_id: 'override',
      },
    ],
    [],
  ).conflicts;

  deepEqual(conflicts, [
    'overrides/mods/override.jar requires library, but it is missing',
  ]);
});

void test('updates mod dependencies of preserved shaderpacks instead of downgrading them', async () => {
  const shader = root('shader', 'shaderpacks/shader.zip', 'shader-old');
  const iris = root('iris', 'mods/iris.jar', 'iris-old');
  const versions = [
    version({
      dependencies: [requires('iris')],
      gameVersions: ['26.2'],
      id: 'shader-old',
      loaders: ['iris'],
      projectId: 'shader',
    }),
    version({ gameVersions: ['26.2'], id: 'iris-old', projectId: 'iris' }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      id: 'iris-new',
      projectId: 'iris',
    }),
  ];

  const result = await resolve([shader, iris], versions);

  strictEqual(result.resolved.get('shader')?.id, 'shader-old');
  strictEqual(result.resolved.get('iris')?.id, 'iris-new');
  deepEqual(
    result.files.map(item => [item.projectId, item.preserve]),
    [
      ['iris', false],
      ['shader', true],
    ],
  );
});

void test('handles shared dependencies between preserved and updated roots', async () => {
  const legacy = root('legacy', 'mods/legacy.jar', 'legacy-old');
  const modern = root('modern', 'mods/modern.jar', 'modern-old');
  const library = root('library', 'mods/library.jar', 'library-old');

  const unpinnedShared = [
    version({
      dependencies: [requires('library')],
      gameVersions: ['26.2'],
      id: 'legacy-old',
      projectId: 'legacy',
    }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('library')],
      id: 'modern-new',
      projectId: 'modern',
    }),
    version({
      gameVersions: ['26.2'],
      id: 'library-old',
      projectId: 'library',
    }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      id: 'library-new',
      projectId: 'library',
    }),
  ];

  const shared = await resolve([legacy, modern, library], unpinnedShared, true);
  strictEqual(shared.resolved.get('legacy')?.id, 'legacy-old');
  strictEqual(shared.resolved.get('modern')?.id, 'modern-new');
  strictEqual(shared.resolved.get('library')?.id, 'library-new');

  const incompatiblyPinned = [
    version({
      dependencies: [requires('library', 'library-old')],
      gameVersions: ['26.2'],
      id: 'legacy-old',
      projectId: 'legacy',
    }),
    version({
      dependencies: [requires('library')],
      id: 'modern-new',
      projectId: 'modern',
    }),
    version({
      gameVersions: ['26.2'],
      id: 'library-old',
      projectId: 'library',
    }),
    version({ id: 'library-new', projectId: 'library' }),
  ];

  await rejects(
    resolve([legacy, modern, library], incompatiblyPinned, true),
    /no compatible build for library@library-old; no compatible root version avoids it\. Replace or remove: legacy, modern/,
  );
});

void test('converges via fallback when mutual root pins encounter an incompatible build', async () => {
  const versions = [
    version({
      date: '2026-02-01T00:00:00.000Z',
      id: 'a-new',
      projectId: 'a',
    }),
    version({
      dependencies: [requires('r', 'r-broken')],
      id: 'a-old',
      projectId: 'a',
    }),
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('a', 'a-old')],
      id: 'r-new',
      projectId: 'r',
    }),
    version({ id: 'r-old', projectId: 'r' }),
    version({ gameVersions: ['26.2'], id: 'r-broken', projectId: 'r' }),
  ];

  const result = await resolve([root('a'), root('r')], versions);

  strictEqual(result.resolved.get('a')?.id, 'a-new');
  strictEqual(result.resolved.get('r')?.id, 'r-old');
});

void test('skips an undownloadable newest release and ranks fractional ISO timestamps', async () => {
  const versions = [
    version({
      date: '2026-03-01T00:00:00Z',
      download: false,
      id: 'app-empty',
      projectId: 'app',
    }),
    version({
      date: '2026-01-01T00:00:00Z',
      id: 'app-whole-second',
      projectId: 'app',
    }),
    version({
      date: '2026-01-01T00:00:00.500Z',
      id: 'app-half-second-newer',
      projectId: 'app',
    }),
  ];

  const result = await resolve([root('app')], versions);

  strictEqual(result.resolved.get('app')?.id, 'app-half-second-newer');
});

void test('rejects duplicate output paths', async () => {
  const unmanagedA: File = {
    ...root('custom-a', 'mods/custom.jar'),
    downloads: ['https://example.invalid/a.jar'],
  };
  const unmanagedB: File = {
    ...root('custom-b', 'mods/custom.jar'),
    downloads: ['https://example.invalid/b.jar'],
  };
  await rejects(
    resolve([unmanagedA, unmanagedB], []),
    /duplicate output path mods\/custom\.jar/,
  );
});

void test('rejects version filenames that escape their directory', async () => {
  const traversalVersion: ModrinthVersion = {
    ...version({ id: 'bad-1', projectId: 'bad' }),
    files: [
      {
        filename: '../outside.jar',
        hashes: { sha1: 'sha1-bad', sha512: 'sha512-bad' },
        primary: true,
        size: 1,
        url: 'https://cdn.modrinth.com/data/bad/versions/bad-1/bad.jar',
      },
    ],
  };
  await rejects(
    resolve([root('bad')], [traversalVersion]),
    /unsafe version filename/,
  );
});

void test('preserves initial conflict cause when fallback attempts fail differently', async () => {
  const versions = [
    version({
      date: '2026-02-01T00:00:00.000Z',
      dependencies: [requires('library', 'library-1')],
      id: 'a-new',
      projectId: 'a',
    }),
    version({
      dependencies: [requires('ancient')],
      id: 'a-old',
      projectId: 'a',
    }),
    version({
      dependencies: [requires('library', 'library-2')],
      id: 'b-new',
      projectId: 'b',
    }),
    version({ id: 'library-1', projectId: 'library' }),
    version({ id: 'library-2', projectId: 'library' }),
  ];

  await rejects(
    resolve([root('a'), root('b')], versions),
    /conflicting required versions for library.*no compatible root-version combination found\. Replace or remove: a, b/,
  );
});

void test('satisfies permutation invariance, idempotence, and soundness across generated dependency graphs', async () => {
  let seed = 0x5eed_cafe;
  const nextInt = (bound: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let z = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    z ^= z + Math.imul(z ^ (z >>> 7), 61 | z);
    return ((z ^ (z >>> 14)) >>> 0) % bound;
  };
  const assetIssue =
    'shaderpacks/shader.zip: exported version old-shader is unavailable on Modrinth; kept as exported without dependency checks';

  for (let run = 0; run < 250; run += 1) {
    const releases = Array.from({ length: 1 + nextInt(6) }, (_, index) =>
      Array.from({ length: nextInt(4) }, (_, v) => `p${index}-v${v}`),
    );
    const allVersions: ModrinthVersion[] = [];

    for (const [index, releaseIds] of releases.entries()) {
      const projectId = `p${index}`;
      allVersions.push(
        version({
          gameVersions: ['26.2'],
          id: `old-${projectId}`,
          projectId,
        }),
      );
      for (const [v, id] of releaseIds.entries()) {
        const dependencies = releases.flatMap((targetReleases, target) => {
          if (target === index || nextInt(3) !== 0) return [];
          const pinned =
            nextInt(2) === 0
              ? null
              : (targetReleases[nextInt(targetReleases.length + 1)] ??
                `old-p${target}`);
          return [
            requires(
              nextInt(5) === 0 && pinned !== null ? null : `p${target}`,
              pinned,
            ),
          ];
        });
        if (nextInt(10) === 0) dependencies.push(requires(null));
        allVersions.push(
          version({
            date: `2026-01-0${v + 1}T00:00:00.${v * 250}Z`,
            dependencies,
            download: nextInt(8) !== 0,
            id,
            projectId,
          }),
        );
      }
    }

    const hasAsset = nextInt(4) === 0;
    const assetGone = hasAsset && nextInt(3) === 0;
    if (hasAsset && !assetGone) {
      const pin = nextInt(2) === 0 ? null : (releases[0]?.[0] ?? 'old-p0');
      allVersions.push(
        version({
          dependencies: nextInt(2) === 0 ? [requires('p0', pin)] : [],
          gameVersions: ['26.2'],
          id: 'old-shader',
          loaders: ['iris'],
          projectId: 'shader',
        }),
      );
    }

    const chosenRoots = [
      ...releases.flatMap((_, index) =>
        nextInt(2) === 0 ? [root(`p${index}`)] : [],
      ),
      ...(hasAsset ? [root('shader', 'shaderpacks/shader.zip')] : []),
      ...(nextInt(4) === 0
        ? [
            {
              ...root('custom', 'mods/custom.jar'),
              downloads: ['https://example.invalid/custom.jar'],
            },
          ]
        : []),
    ];
    const shuffled = [...chosenRoots];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = nextInt(i + 1);
      const left = shuffled[i];
      const right = shuffled[j];
      if (left !== undefined && right !== undefined) {
        shuffled[i] = right;
        shuffled[j] = left;
      }
    }
    const preserve = nextInt(3) === 0;

    let first: Awaited<ReturnType<typeof resolve>> | null = null;
    let firstError = '';
    try {
      first = await resolve(chosenRoots, allVersions, preserve);
    } catch (caught) {
      firstError = caught instanceof Error ? caught.message : String(caught);
    }

    if (first === null) {
      await rejects(resolve(shuffled, allVersions, preserve), {
        message: firstError,
      });
      continue;
    }

    const permuted = await resolve(shuffled, allVersions, preserve);
    deepEqual(permuted.files, first.files);
    deepEqual(permuted.issues, first.issues);
    deepEqual(permuted.unresolved, first.unresolved);
    deepEqual([...permuted.resolved], [...first.resolved]);

    deepEqual(checkConflicts([...first.resolved.values()], []).conflicts, []);
    deepEqual(first.issues, assetGone ? [assetIssue] : []);
    strictEqual(first.resolved.has('shader'), hasAsset && !assetGone);

    if (!preserve) {
      const replay = await resolve(
        first.files.map(item => item.file),
        allVersions,
        false,
      );
      deepEqual(replay.files, first.files);
      deepEqual(replay.issues, first.issues);
      deepEqual([...replay.resolved], [...first.resolved]);
      deepEqual(replay.unresolved, []);
    }
  }
});
