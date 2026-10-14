import type { JobState } from "../../../packages/shared/types";
export type { JobState } from "../../../packages/shared/types";
export const jobStates = ["QUEUED", "ASSIGNED", "RUNNING", "WAITING_FOR_APPROVAL", "VERIFYING", "COMPLETED_VERIFIED", "COMPLETED_UNVERIFIED", "FAILED", "CANCELED", "INTERRUPTED"] as const;
const transitions: Record<JobState, readonly JobState[]> = {
  QUEUED: ["ASSIGNED", "RUNNING", "FAILED", "CANCELED", "INTERRUPTED"],
  ASSIGNED: ["RUNNING", "FAILED", "CANCELED", "INTERRUPTED"],
  RUNNING: ["WAITING_FOR_APPROVAL", "VERIFYING", "COMPLETED_UNVERIFIED", "FAILED", "CANCELED", "INTERRUPTED"],
  WAITING_FOR_APPROVAL: ["RUNNING", "VERIFYING", "FAILED", "CANCELED", "INTERRUPTED"],
  VERIFYING: ["COMPLETED_VERIFIED", "COMPLETED_UNVERIFIED", "FAILED", "CANCELED", "INTERRUPTED"],
  COMPLETED_VERIFIED: [], COMPLETED_UNVERIFIED: [], FAILED: [], CANCELED: [], INTERRUPTED: [],
};
export function assertJobTransition(from: JobState, to: JobState) {
  if (!jobStates.includes(to) || (from !== to && !transitions[from]?.includes(to))) throw new Error(`Invalid job transition: ${from} → ${to}`);
}
