import { type Json, parseJson } from './json.js';

export const USER_AGENT = 'mc-aset-loveland (local pack updater)';

export const request = (url: string): Promise<Response> =>
  fetch(url, { headers: { 'user-agent': USER_AGENT } });

export const getJson = async (url: string): Promise<Json> => {
  const res = await request(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseJson(await res.text());
};
