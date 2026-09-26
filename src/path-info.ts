import { lstatSync, realpathSync, statSync } from "node:fs";

export interface PathInfo {
  isDirectory: boolean;
  isSymlink: boolean;
  realPath?: string;
}

export function safeRealPathSync(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function getPathInfoSync(path: string): PathInfo {
  try {
    const linkStat = lstatSync(path);
    const isSymlink = linkStat.isSymbolicLink();
    const targetStat = isSymlink ? statSync(path) : linkStat;
    return {
      isDirectory: targetStat.isDirectory(),
      isSymlink,
      realPath: targetStat.isDirectory() ? safeRealPathSync(path) : undefined,
    };
  } catch {
    return { isDirectory: false, isSymlink: false };
  }
}
