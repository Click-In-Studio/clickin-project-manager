export type AdmissionResource = "context" | "llm" | "local_tool" | "mmp";
export type AdmissionClass = "interactive" | "subagent" | "schedule";
export const ADMISSION_PRIORITY: Record<AdmissionClass, number> = {
  interactive: 20, subagent: 10, schedule: 0,
};
export interface AdmissionTicket {
  id: string;
  run_id: string;
  resource: AdmissionResource;
  state: "ready" | "active" | "done" | "failed" | "unknown";
  remote_id: string | null;
  result: unknown;
  owner: string | null;
  started_at: Date | null;
}
export type InputWait =
  | { kind: "all"; waits: InputWait[]; ids: string[] }
  | { kind: "question" | "approval"; id: string }
  | { kind: "subagent"; ids: string[]; deadline: number };
