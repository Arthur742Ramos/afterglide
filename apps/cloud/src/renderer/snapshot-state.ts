import type { AppSnapshot, SnapshotUpdate } from "../shared/contracts";

/** Preserve catalog identity and reject replies/events older than local state. */
export function mergeSnapshot(
  current: AppSnapshot | undefined,
  update: SnapshotUpdate,
): AppSnapshot | undefined {
  if (current && update.revision <= current.revision) return current;
  const titles = update.cloud.titles ?? current?.cloud.titles;
  if (!titles) return current; // Wait for the full getSnapshot baseline.
  return { ...update, cloud: { ...update.cloud, titles } };
}

export function hydrateSnapshot(
  current: AppSnapshot | undefined,
  baseline: AppSnapshot,
  latest?: SnapshotUpdate,
): AppSnapshot {
  const base =
    !current || baseline.revision > current.revision ? baseline : current;
  return (latest && mergeSnapshot(base, latest)) || base;
}
