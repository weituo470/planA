export type SpecArtifact = 'requirements' | 'design' | 'tasks';

export interface ClarificationOption {
  id: string;
  label: string;
}

export interface ClarificationAnswer {
  selectedOptionIds: string[];
  otherText: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  mode: 'single' | 'multi';
  required: boolean;
  allowOther: boolean;
  options: ClarificationOption[];
  answer: ClarificationAnswer;
  createdAt: string;
}

export interface RequirementsClarifications {
  questions: ClarificationQuestion[];
  generatedBy?: 'llm' | 'default' | string | null;
  generationError?: string | null;
  updatedAt: string | null;
  confirmedAt: string | null;
}

export interface SpecStatus {
  requirementsConfirmed: boolean;
  designConfirmed: boolean;
  tasksConfirmed: boolean;
  requirementsClarifications?: RequirementsClarifications;
}

export interface SpecSummary {
  name: string;
  files: Partial<Record<SpecArtifact, boolean>>;
  status?: SpecStatus;
}

export interface LlmOption {
  id: string;
  label: string;
  providerId: string;
}

export interface LlmProviderInfo {
  id: string;
  label: string;
  baseUrl: string | null;
  baseUrlPresent: boolean;
  apiKeyPresent: boolean;
}

export interface LlmInfo {
  hasConfig: boolean;
  model: string | null;
  providerId: string | null;
  baseUrl: string | null;
  responseFormat: string | null;
  options: LlmOption[];
  providers: LlmProviderInfo[];
}
