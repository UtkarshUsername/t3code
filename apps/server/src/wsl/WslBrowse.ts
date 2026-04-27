import type { FilesystemBrowseResult } from "@t3tools/contracts";

export const WSL_BROWSE_SCRIPT = [
  "set -eu",
  "partial=${1-}",
  'case "$partial" in',
  '  "~") partial=$HOME ;;',
  '  "~/"*) partial=$HOME/${partial#~/} ;;',
  "esac",
  'case "$partial" in',
  '  /*) target=$(realpath -m -- "$partial") ;;',
  '  *) target=$(realpath -m -- "$PWD/$partial") ;;',
  "esac",
  'if [ -z "$partial" ]; then',
  "  parent=$target; prefix=",
  "else",
  '  case "$partial" in',
  "    */) parent=$target; prefix= ;;",
  '    *) parent=$(dirname -- "$target"); prefix=$(basename -- "$target") ;;',
  "  esac",
  "fi",
  '[ -d "$parent" ] || exit 3',
  'printf "%s\\0%s\\0" "$parent" "$prefix"',
  'find "$parent" -mindepth 1 -maxdepth 1 -type d -printf "%f\\0%p\\0"',
].join("\n");

export function parseWslBrowseOutput(stdout: string): FilesystemBrowseResult {
  const parts = stdout.split("\0");
  const parentPath = parts[0]?.trim();
  const prefix = parts[1] ?? "";
  if (!parentPath) {
    throw new Error("WSL browse response did not include a parent path.");
  }

  const lowerPrefix = prefix.toLowerCase();
  const showHidden = prefix.length === 0 || prefix.startsWith(".");
  const entries: Array<FilesystemBrowseResult["entries"][number]> = [];

  for (let index = 2; index + 1 < parts.length; index += 2) {
    const name = parts[index];
    const fullPath = parts[index + 1];
    if (!name || !fullPath) continue;
    if (!name.toLowerCase().startsWith(lowerPrefix)) continue;
    if (!showHidden && name.startsWith(".")) continue;
    entries.push({ name, fullPath });
  }

  return {
    parentPath,
    entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
  };
}
