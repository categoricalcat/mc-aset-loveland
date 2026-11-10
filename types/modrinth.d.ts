export interface Dependencies {
  'fabric-loader': string;
  minecraft: string;
}

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
  summary: string;
  versionId: string;
}
