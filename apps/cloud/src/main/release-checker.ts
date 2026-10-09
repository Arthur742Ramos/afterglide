import type { UpdateSnapshot } from "../shared/contracts";

// A separate approved release source is required before enabling updates.
export interface ReleaseCheckPort {
  check(currentVersion: string): Promise<UpdateSnapshot>;
}
