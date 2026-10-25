import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useCopyToClipboard } from "./useCopyToClipboard";

function VersionCopy() {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 0 });
  return (
    <>
      <button onClick={() => copyToClipboard("0.1.3", undefined)}>Copy version</button>
      <output>{isCopied ? "Copied" : "Ready to copy"}</output>
    </>
  );
}

it("clears success feedback when a subsequent clipboard write fails", async () => {
  // The clipboard hook has no routing dependencies.
  await using screen = await render(<VersionCopy />, { router: false });
  using _write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Clipboard write denied"));
  using _error = vi.spyOn(console, "error").mockImplementation(() => {});

  await screen.getByRole("button", { name: "Copy version" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Copied");

  await screen.getByRole("button", { name: "Copy version" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Ready to copy");
});
