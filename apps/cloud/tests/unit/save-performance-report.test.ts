import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { savePerformanceReport } from "../../src/main/save-performance-report";

it("writes complete JSON privately and keeps successive exports distinct", async () => {
  const directory = await mkdtemp(join(tmpdir(), "afterglide-export-"));
  try {
    const report = { samples: [{ fps: 0 }], retainedSamples: 1 };
    const first = await savePerformanceReport(directory, report);
    const second = await savePerformanceReport(directory, { samples: [] });
    expect(first).not.toBe(second);
    expect(JSON.parse(await readFile(first, "utf8"))).toEqual(report);
    expect(JSON.parse(await readFile(second, "utf8"))).toEqual({ samples: [] });
    expect(await readdir(directory)).toHaveLength(2);
    if (process.platform !== "win32")
      expect((await stat(first)).mode & 0o777).toBe(0o600);
    await expect(
      savePerformanceReport(join(directory, "missing"), report),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
