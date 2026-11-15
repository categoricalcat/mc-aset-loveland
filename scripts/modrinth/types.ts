export interface Dependencies {
  'fabric-loader'?: string;
  minecraft: string;
  neoforge?: string;
}

export type DependencyType =
  'embedded' | 'incompatible' | 'optional' | 'required';

export interface Env {
  client: 'optional' | 'required' | 'unsupported';
  server: 'optional' | 'required' | 'unsupported';
}

export interface File {
  downloads: string[];
  env: Env;
  fileSize: number;
  hashes: Hashes;
  path: string;
}

export interface Hashes {
  sha1: string;
  sha512: string;
}

export interface ModrinthIndex {
  dependencies: Dependencies;
  files: File[];
  formatVersion: number;
  game: string;
  name: string;
  summary?: string;
  versionId: string;
}

export interface ModrinthProject {
  id: string;
  loaders: string[];
}

export interface ModrinthVersion {
  date_published: string;
  dependencies: VersionDependency[];
  files: VersionFile[];
  game_versions: string[];
  id: string;
  loaders: string[];
  project_id: string;
  version_number: string;
  version_type: string;
}

export interface ResolvedPackFile {
  file: File;
  preserve: boolean;
  projectId: null | string;
}

export interface ResolvedVersion extends Pick<
  ModrinthVersion,
  'dependencies' | 'id' | 'project_id'
> {
  path: string;
}

export interface VersionDependency {
  dependency_type: DependencyType;
  project_id: null | string;
  version_id: null | string;
}

export interface VersionFile {
  filename: string;
  hashes: Hashes;
  primary: boolean;
  size: number;
  url: string;
}

export interface VersionQuery {
  game: string;
  loaders: readonly string[];
  projectId: string;
}

export interface VersionSource {
  fetchProjectVersions: (
    query: VersionQuery,
  ) => Promise<null | readonly ModrinthVersion[]>;
  fetchVersionById: (versionId: string) => Promise<ModrinthVersion | null>;
}
