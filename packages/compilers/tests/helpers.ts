import { readFileSync } from "node:fs";

import type { CompileResult, GeneratedTextFile } from "../src/index.js";

export function textOutput(result: CompileResult, path: string): string {
  const file = result.files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`No generated file named ${path}`);
  if (typeof file.content !== "string") throw new Error(`${path} is not a text file`);
  return file.content;
}

export function golden(name: string): string {
  return readFileSync(new URL(`./golden/${name}`, import.meta.url), "utf8");
}

export function isTextFile(file: CompileResult["files"][number]): file is GeneratedTextFile {
  return typeof file.content === "string";
}
