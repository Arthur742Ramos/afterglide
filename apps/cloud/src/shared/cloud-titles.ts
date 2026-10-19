import type { CloudTitle } from "./contracts";

export function compareCloudTitles(
  left: CloudTitle,
  right: CloudTitle,
): number {
  if (left.recentlyPlayed !== right.recentlyPlayed)
    return left.recentlyPlayed ? -1 : 1;
  if (left.recentlyPlayed) {
    const rankDifference =
      (left.recentPlayRank ?? Number.MAX_SAFE_INTEGER) -
      (right.recentPlayRank ?? Number.MAX_SAFE_INTEGER);
    if (rankDifference) return rankDifference;
  }
  return left.name.localeCompare(right.name);
}
