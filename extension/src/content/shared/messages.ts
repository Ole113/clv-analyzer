import type { SnapshotPayload } from "@clv/shared";

export interface CaptureMessage {
  type: "clv:capture";
  payload: SnapshotPayload;
}

export interface CaptureResponse {
  ok: boolean;
  queued?: boolean;
  error?: string;
  status?: string;
}

/** Asks the server which of the rows currently on the board are already tracked. */
export interface TrackedLookupMessage {
  type: "clv:tracked";
  matchKeys: string[];
}

export interface TrackedLookupResponse {
  ok: boolean;
  /** Match keys that have an open pick on the server. */
  tracked?: string[];
  error?: string;
}

/** Removes a pick after the user unticks its row. */
export interface UntrackMessage {
  type: "clv:untrack";
  matchKey: string;
}

export interface UntrackResponse {
  ok: boolean;
  error?: string;
}

export interface TestConnectionMessage {
  type: "clv:test-connection";
}
