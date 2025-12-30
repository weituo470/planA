export type WorkflowStatus = 'Thinking' | 'Executing' | 'Reviewing';

export interface WorkflowEvent<T = any> {
  id: string;
  type: string;
  payload: T;
  timestamp: string;
}

export interface TaskGraph {
  nodes: Array<{ id: string; data: { label: string; status?: string }; position: { x: number; y: number } }>;
  edges: Array<{ id: string; source: string; target: string }>;
}

export interface DiffPreview {
  filePath: string;
  diff: string;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  description?: string;
  options?: string[];
}

export interface TestReport {
  status: 'pass' | 'fail';
  summary: string;
  details?: string;
}

export type SpecArtifact = 'requirements' | 'design' | 'tasks';

export interface SpecStatus {
  requirementsConfirmed: boolean;
  designConfirmed: boolean;
  tasksConfirmed: boolean;
}

export interface SpecSummary {
  name: string;
  files: Partial<Record<SpecArtifact, boolean>>;
  status?: SpecStatus;
}

export interface BridgeState {
  status: WorkflowStatus;
  tasks: TaskGraph;
  lastDiff: DiffPreview | null;
  approvals: ApprovalRequest[];
  testReport: TestReport | null;
  logs: Array<{ source: string; message: string }>;
}
