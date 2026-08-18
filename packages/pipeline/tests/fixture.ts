import { readFileSync } from "node:fs";

export function fixtureText(path: string): string {
  return readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), "utf8");
}

export function fixtureJson(path: string): unknown {
  return JSON.parse(fixtureText(path)) as unknown;
}
