import { resolve } from "node:path";

export function getObservedToolActivityPath(toolName: string, input: unknown, cwd: string): string | undefined {
  if (toolName !== "write" && toolName !== "edit") return undefined;
  if (!input || typeof input !== "object") return undefined;

  const field = toolName === "write" ? "path" : "file";
  const path = (input as Record<string, unknown>)[field];
  return typeof path === "string" && path.trim() ? resolve(cwd, path) : undefined;
}
