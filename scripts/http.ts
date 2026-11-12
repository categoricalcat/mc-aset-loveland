import { type Json, parseJson } from './json.js';

export const USER_AGENT = 'mc-aset-loveland (local pack updater)';

export const request = (url: string, init?: RequestInit): Promise<Response> => {
  const headers = new Headers(init?.headers);
  headers.set('user-agent', USER_AGENT);
  return fetch(url, { ...init, headers });
};

export const getJson = async (url: string): Promise<Json> => {
  const res = await request(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseJson(await res.text());
};
