export type Json =
  boolean | Json[] | null | number | string | { [key: string]: Json };

export type JsonObject = Record<string, Json>;

// JSON.parse is untyped. Json is every value it can return.
export const parseJson = (text: string): Json => JSON.parse(text) as Json;

export const isJsonObject = (value: Json): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isStringArray = (value: Json): value is string[] =>
  Array.isArray(value) &&
  value.every((item): item is string => typeof item === 'string');
