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

export interface TestConnectionMessage {
  type: "clv:test-connection";
}
