import { describe, expect, it } from "vitest";

import { parseWslBrowseOutput } from "./WslBrowse.ts";

describe("parseWslBrowseOutput", () => {
  it("parses nul-delimited WSL directory browse output", () => {
    expect(
      parseWslBrowseOutput(
        ["/home/me", "pr", "project", "/home/me/project", "notes", "/home/me/notes", ""].join("\0"),
      ),
    ).toEqual({
      parentPath: "/home/me",
      entries: [{ name: "project", fullPath: "/home/me/project" }],
    });
  });

  it("hides dot directories unless the prefix requests them", () => {
    expect(
      parseWslBrowseOutput(
        ["/home/me", "", ".config", "/home/me/.config", "src", "/home/me/src", ""].join("\0"),
      ),
    ).toEqual({
      parentPath: "/home/me",
      entries: [
        { name: ".config", fullPath: "/home/me/.config" },
        { name: "src", fullPath: "/home/me/src" },
      ],
    });

    expect(
      parseWslBrowseOutput(
        ["/home/me", "s", ".ssh", "/home/me/.ssh", "src", "/home/me/src", ""].join("\0"),
      ),
    ).toEqual({
      parentPath: "/home/me",
      entries: [{ name: "src", fullPath: "/home/me/src" }],
    });
  });

  it("throws when parent path is missing", () => {
    expect(() => parseWslBrowseOutput("")).toThrow("parent path");
  });
});
