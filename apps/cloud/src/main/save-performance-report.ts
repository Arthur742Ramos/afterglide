import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** One explicit export creates one private file; never overwrite a prior run. */
export async function savePerformanceReport(
  directory: string,
  report: unknown,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = join(
    directory,
    `afterglide-cloud-performance-${timestamp}-${randomUUID()}.json`,
  );
  await writeFile(destination, JSON.stringify(report, null, 2), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return destination;
}
