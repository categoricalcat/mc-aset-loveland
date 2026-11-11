import { getJson } from './http.js';
import { isJsonObject, isStringArray, type Json } from './json.js';

export type Loader = 'fabric' | 'neoforge';

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
    if (Number.isNaN(diff)) return 0;
    if (diff !== 0) return diff;
  }
  return 0;
};

const latestNumeric = (versions: readonly string[]): string | undefined =>
  versions.reduce<string | undefined>(
    (best, version) =>
      best === undefined || compareVersions(version, best) > 0 ? version : best,
    undefined,
  );

const neoforgeFor = (body: Json, game: string): null | string => {
  if (!isJsonObject(body)) return null;
  const versions = body['versions'];
  if (versions === undefined || !isStringArray(versions)) return null;
  return (
    latestNumeric(
      versions.filter(
        version => version.startsWith(`${game}.`) && !version.includes('-'),
      ),
    ) ?? null
  );
};

const fabricStable = (body: Json): null | string => {
  if (!Array.isArray(body)) return null;
  for (const entry of body) {
    if (!isJsonObject(entry)) continue;
    const loader = entry['loader'];
    if (
      loader !== undefined &&
      isJsonObject(loader) &&
      loader['stable'] === true &&
      typeof loader['version'] === 'string'
    ) {
      return loader['version'];
    }
  }
  return null;
};

export const latestLoaderVersion = async (
  loader: Loader,
  game: string,
): Promise<string> => {
  if (loader === 'neoforge') {
    const version = neoforgeFor(
      await getJson(
        'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
      ),
      game,
    );
    if (version === null) throw new Error(`no NeoForge build for ${game}`);
    return version;
  }

  const version = fabricStable(
    await getJson(`https://meta.fabricmc.net/v2/versions/loader/${game}`),
  );
  if (version === null) throw new Error(`no Fabric loader for ${game}`);
  return version;
};
