/**
 * MVP5 类型定义
 */

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  level: number;
  inDegree: number;
  outDegree: number;
  riskLevel?: 'low' | 'medium' | 'high';
  requiresInteraction?: boolean;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'file' | 'api' | 'data' | 'explicit' | 'conflict';
  strength: 'strong' | 'weak';
  description: string;
}

export interface TaskGroup {
  level: number;
  taskIds: string[];
  canRunSimultaneously: boolean;
}

export interface CriticalPath {
  path: string[];
  totalDuration: number;
}

export interface TaskGraph {
  tasks: TaskNode[];
  edges: DependencyEdge[];
  adjacency: Record<string, { in: Array<{ to: string; type: string }>; out: Array<{ from: string; type: string }> }>;
  topologicalOrder: string[];
  hasCycle: boolean;
  cycles: string[];
  parallelGroups: TaskGroup[];
  criticalPath: CriticalPath;
}

export interface ExecutionPhase {
  phaseId: string;
  phaseIndex: number;
  type: 'parallel' | 'serial';
  taskIds: string[];
  canRunSimultaneously: boolean;
  dependsOnPhases: string[];
  suggestedCli?: 'codex' | 'claude' | 'mixed';
  estimatedDuration?: number;
}

export interface Recommendation {
  feasible: boolean;
  type?: 'parallel' | 'serial' | 'hybrid';
  description: string;
  phases: ExecutionPhase[];
  estimatedTotalTime: number;
  cliAllocation: Record<string, 'codex' | 'claude'>;
  parallelism?: {
    score: number;
    description: string;
    maxParallelGroupSize: number;
  };
  rationale?: string;
  priority?: 'high' | 'medium' | 'low';
  label?: string;
}

export interface PlatformNote {
  compatible: boolean;
  issues: Array<{
    type: string;
    count?: number;
    message: string;
  }>;
}

export interface ExecutionSummary {
  totalTasks: number;
  totalDependencies: number;
  parallelGroups: number;
  maxParallelGroupSize: number;
  criticalPathLength: number;
  estimatedDuration: number;
  warnings: string[];
  hasCycle: boolean;
  hasConflicts: boolean;
}

export interface AnalysisResult {
  analysisId: string;
  specId: string;
  analyzedAt: string;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    riskLevel: 'low' | 'medium' | 'high';
    requiresInteraction: boolean;
  }>;
  graph: TaskGraph;
  recommendations: Recommendation[];
  warnings: string[];
  platformNotes?: PlatformNote;
  summary: ExecutionSummary;
}

export interface ExecutionPlan {
  planId: string;
  specId: string;
  analysisId: string;
  createdAt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  phases: ExecutionPhase[];
  cliAllocation: Record<string, 'codex' | 'claude'>;
  modifications: {
    taskCliOverrides?: Record<string, 'codex' | 'claude'>;
    excludedTasks?: string[];
  };
  estimatedDuration: number;
  executionId?: string;
}

export interface TaskExecutionStatus {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  cli: 'codex' | 'claude' | 'manual';
  startedAt?: string;
  completedAt?: string;
  error?: string;
  retryCount: number;
}

export interface ExecutionState {
  executionId: string;
  planId: string;
  specId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused';
  currentPhase: number;
  tasks: Record<string, TaskExecutionStatus>;
  failures: Array<{
    taskId: string;
    phaseId: string;
    error: string;
    canRetry: boolean;
    downstreamAffected: string[];
  }>;
  startedAt: string;
  updatedAt: string;
}

// React Flow 节点数据类型
export interface FlowNodeData {
  id: string;
  label: string;
  type: 'task' | 'phase' | 'start' | 'end';
  status?: 'pending' | 'running' | 'completed' | 'failed';
  cli?: 'codex' | 'claude';
  riskLevel?: 'low' | 'medium' | 'high';
  phaseIndex?: number;
}
