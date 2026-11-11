export interface Dependencies {
  'fabric-loader': string;
  minecraft: string;
}

export interface DonationUrl {
  id: string;
  platform: string;
  url: string;
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

export interface License {
  id: string;
  name: string;
  url: unknown;
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

export interface ModrinthProject {
  additional_categories: unknown[];
  approved: string;
  body: string;
  body_url: unknown;
  categories: string[];
  client_side: Env['client'];
  color: number;
  description: string;
  discord_url: unknown;
  donation_urls: DonationUrl[];
  downloads: number;
  followers: number;
  gallery: unknown[];
  game_versions: string[];
  icon_url: string;
  id: string;
  issues_url: string;
  license: License;
  loaders: string[];
  moderator_message: unknown;
  monetization_status: string;
  organization: unknown;
  project_type: string;
  published: string;
  queued: unknown;
  requested_status: unknown;
  server_side: Env['server'];
  slug: string;
  source_url: string;
  status: string;
  team: string;
  thread_id: string;
  title: string;
  updated: string;
  versions: string[];
  wiki_url: string;
}
