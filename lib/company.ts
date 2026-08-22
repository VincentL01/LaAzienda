export const employeeStatuses = ["offline", "starting", "idle", "planning", "working", "waiting", "review", "done", "failed"] as const;
export const taskStatuses = ["queued", "working", "review", "done"] as const;
export const animationStates = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"] as const;
export const runtimeStatuses = ["not_provisioned", "created", "running", "paused", "restarting", "removing", "exited", "dead", "not_found"] as const;
export const desiredRuntimeStatuses = ["running", "stopped"] as const;
export const cacheStatuses = ["requested", "observed", "cached", "drifted", "failed"] as const;
export const mailboxStatuses = ["requested", "ready", "failed"] as const;
export const mailStatuses = ["queued", "sending", "sent", "failed"] as const;
export const employmentTypes = ["executive", "expert", "contractor"] as const;
export const workspacePolicies = ["persistent", "task-scoped"] as const;
export const resourceAccessPolicies = ["read-all", "docker-provisioner", "project-write", "task-scoped"] as const;
export const petPolicies = ["fixed", "random"] as const;
export const agentRunStatuses = ["claimed", "running", "completed", "needs_input", "failed"] as const;
export const secretaryInquiryStatuses = ["queued", "running", "answered", "failed"] as const;
export const systemIncidentStatuses = ["pending", "filing", "filed", "blocked"] as const;
export const trainingSyncStatuses = ["pending", "verified", "failed"] as const;
export const codexAuthenticationRequiredMessage = "Codex authentication needs to be refreshed by the CEO.";
export const githubAuthenticationRequiredMessage = "GitHub authentication needs to be configured by the CEO.";

export type EmployeeStatus = (typeof employeeStatuses)[number];
export type TaskStatus = (typeof taskStatuses)[number];
export type AnimationState = (typeof animationStates)[number];
export type RuntimeStatus = (typeof runtimeStatuses)[number];
export type DesiredRuntimeStatus = (typeof desiredRuntimeStatuses)[number];
export type CacheStatus = (typeof cacheStatuses)[number];
export type MailboxStatus = (typeof mailboxStatuses)[number];
export type MailStatus = (typeof mailStatuses)[number];
export type EmploymentType = (typeof employmentTypes)[number];
export type WorkspacePolicy = (typeof workspacePolicies)[number];
export type ResourceAccessPolicy = (typeof resourceAccessPolicies)[number];
export type PetPolicy = (typeof petPolicies)[number];
export type AgentRunStatus = (typeof agentRunStatuses)[number];
export type SecretaryInquiryStatus = (typeof secretaryInquiryStatuses)[number];
export type SystemIncidentStatus = (typeof systemIncidentStatuses)[number];
export type TrainingSyncStatus = (typeof trainingSyncStatuses)[number];

export interface Employee {
  id: string; name: string; role: string; department: string; status: EmployeeStatus;
  petId: string; spritesheetPath?: string | null; roleProfileId: string | null; emailAddress: string | null;
  employmentType: EmploymentType; workspacePolicy: WorkspacePolicy;
  resourceAccess: ResourceAccessPolicy; dockerSocketAccess: boolean; handoffRequired: boolean;
  mailboxStatus: MailboxStatus; systemPrompt: string; containerName: string | null;
  desiredRuntimeStatus: DesiredRuntimeStatus; runtimeStatus: RuntimeStatus;
  lastRuntimeAt: string | null; currentTaskId: string | null; createdAt: string;
  skills: TrainingSkill[]; desiredSkills: DesiredEmployeeSkill[];
}

export interface CompanyRole {
  id: string; title: string; department: string; mission: string; systemPrompt: string;
  recommendedSkills: string[]; employmentType: EmploymentType; workspacePolicy: WorkspacePolicy;
  resourceAccess: ResourceAccessPolicy; dockerSocketAccess: boolean; handoffRequired: boolean;
  petPolicy: PetPolicy; fixedPetId: string | null; isSingleton: boolean;
  harness: string; modelPolicy: string; isCore: boolean; sortOrder: number;
}

export interface RuntimeProfile {
  id: string; imageTag: string; harness: string; baseTools: string[];
  codexHome: string; workspacePath: string; skillsPath: string;
  authContract: string; dockerSocketPolicy: string; description: string;
}

export interface MailMessage {
  id: string; messageKey: string; senderEmployeeId: string; senderName: string;
  senderEmail: string | null; recipientEmployeeId: string; recipientName: string;
  recipientEmail: string | null; subject: string; body: string; status: MailStatus;
  transport: "stalwart"; lastError: string | null; createdAt: string; sentAt: string | null;
}

export interface TrainingSkill {
  id: string; packageRef: string; name: string; description: string;
  sourceUrl: string | null; installCommand: string; cacheStatus: CacheStatus;
  folderKey: string | null; observedDigest: string | null; observedAt: string | null;
  observationStatus: "observed" | "missing" | "failed" | null; observationEvidence: string | null;
  approvedDigest: string | null; approvalVersion: number; approvedAt: string | null;
  createdAt: string; cachedAt: string | null; updatedAt: string;
}

export interface DesiredEmployeeSkill extends TrainingSkill {
  assignmentVersion: number; assignedAt: string; desiredUpdatedAt: string; folderKey: string;
}

export interface TrainingEmployee {
  id: string; name: string; role: string; department: string;
}

export interface TrainingAssignment {
  employeeId: string; employeeName: string; skillId: string; skillName: string;
  packageRef: string; folderKey: string; assignedAt: string; desiredUpdatedAt: string; desiredOperation: "install" | "remove";
  assignmentVersion: number; status: TrainingSyncStatus;
  manifestVersion: string | null; sourceHash: string | null; stagedHash: string | null; verifiedHash: string | null;
  attempts: number; evidence: string; verifiedAt: string | null; lastAttemptAt: string | null;
}

export interface TrainingSyncEvent {
  id: number; eventKey: string; employeeId: string; employeeName: string;
  skillId: string; skillName: string; operation: "install" | "remove";
  assignmentVersion: number; status: Exclude<TrainingSyncStatus, "pending">;
  manifestVersion: string | null; sourceHash: string | null; stagedHash: string | null; verifiedHash: string | null;
  evidence: string; workerId: string; attempts: number; verifiedAt: string | null;
  createdAt: string; updatedAt: string;
}

export interface CharacterPack {
  id: string; displayName: string; description: string; sourceUrl: string | null;
  installCommand: string | null; spritesheetPath: string | null;
  spriteVersion: number; cacheStatus: CacheStatus; createdAt: string; cachedAt: string | null;
}

export interface RuntimeEvent {
  id: number; eventKey: string; employeeId: string; containerStatus: RuntimeStatus;
  employeeStatus: EmployeeStatus; detail: string; createdAt: string;
}

export interface RepositorySync {
  id: string; repository: string; branch: "main"; sourceBranch: string;
  commitSha: string; pullNumber: number | null; syncedAt: string;
}

export interface SystemIncident {
  id: string; fingerprint: string; category: "api_5xx" | "worker_exception"; source: "worker";
  route: string; method: string; httpStatus: number | null; summary: string; evidence: string;
  runId: string; employeeId: string; taskId: string | null; buildCommit: string | null;
  occurrenceCount: number; status: SystemIncidentStatus; issueNumber: number | null; issueUrl: string | null;
  filingAttempts: number; nextAttemptAt: string | null; lastFilingError: string | null;
  firstSeenAt: string; lastSeenAt: string;
}

export interface WorkforceState {
  employees: Employee[]; skills: TrainingSkill[]; characters: CharacterPack[];
  runtimeEvents: RuntimeEvent[]; roles: CompanyRole[]; runtimeProfile: RuntimeProfile;
}

export interface MailroomState {
  employees: Employee[]; roles: CompanyRole[]; messages: MailMessage[];
  mailDomain: string; transport: "stalwart"; runtimeProfile: RuntimeProfile;
}

export interface TrainingCenterState {
  skills: TrainingSkill[]; characters: CharacterPack[]; employees: TrainingEmployee[];
  assignments: TrainingAssignment[]; history: TrainingSyncEvent[];
  discoveryCommand: string; petCatalogUrl: string; ownerAuthorized: boolean;
  desiredGeneration: number;
}

export interface CompanyTask {
  id: string; title: string; brief: string; status: TaskStatus;
  priority: "low" | "normal" | "high"; assigneeId: string | null;
  projectId: string | null; handoffRequired: boolean;
  createdAt: string; updatedAt: string;
}

export interface CompanyProject {
  id: string; name: string; brief: string; githubOwner: string;
  repositoryName: string | null; repositoryUrl: string | null;
  visibility: "public"; status: "planned" | "approved" | "provisioned" | "active" | "archived";
  managerId: string | null; createdAt: string; updatedAt: string;
}

export interface KnowledgeEntry {
  id: string; title: string; summary: string; sourceType: string;
  sourceRef: string | null; contributedBy: string | null; taskId: string | null;
  status: "candidate" | "approved"; createdAt: string;
}

export interface ContractorHandoff {
  id: string; handoffKey: string; taskId: string; employeeId: string;
  summary: string; deliverables: string; decisions: string; followUp: string;
  knowledgeEntryId: string; status: "accepted"; createdAt: string;
}

export interface AnimationMapping {
  employeeStatus: EmployeeStatus; animationState: AnimationState; speedMs: number;
}

export interface ActivityItem {
  id: number; message: string; tone: string; createdAt: string;
}

export interface AgentRun {
  id: string; jobType: "task" | "secretary-inquiry"; jobId: string;
  taskId: string | null; employeeId: string; status: AgentRunStatus; attempt: number;
  workerId: string; promptSummary: string; lastEvent: string;
  resultSummary: string; deliverables: string[]; decisions: string[];
  followUp: string[]; knowledge: string; error: string | null; threadId: string | null;
  leaseExpiresAt: string | null; heartbeatAt: string | null; startedAt: string | null;
  finishedAt: string | null; createdAt: string; updatedAt: string;
}

export interface AgentRunEvent {
  id: number; eventKey: string; runId: string; employeeId: string;
  eventType: string; message: string; createdAt: string;
}

export interface SecretaryInquiry {
  id: string; question: string; status: SecretaryInquiryStatus; answer: string;
  runId: string | null; createdAt: string; answeredAt: string | null; updatedAt: string;
}

export interface CompanyState {
  employees: Employee[]; tasks: CompanyTask[]; mappings: AnimationMapping[]; activity: ActivityItem[];
  projects: CompanyProject[]; knowledge: KnowledgeEntry[]; handoffs: ContractorHandoff[];
  runs: AgentRun[]; runEvents: AgentRunEvent[]; secretaryInquiries: SecretaryInquiry[];
  repositorySyncs: RepositorySync[]; systemIncidents: SystemIncident[];
}

export const spriteTracks: Record<AnimationState, { row: number; frames: number; label: string }> = {
  idle: { row: 0, frames: 7, label: "Idle" },
  "running-right": { row: 1, frames: 8, label: "Move right" },
  "running-left": { row: 2, frames: 8, label: "Move left" },
  waving: { row: 3, frames: 4, label: "Celebrate" },
  jumping: { row: 4, frames: 5, label: "Jump" },
  failed: { row: 5, frames: 8, label: "Failed" },
  waiting: { row: 6, frames: 7, label: "Waiting" },
  running: { row: 7, frames: 6, label: "Working" },
  review: { row: 8, frames: 6, label: "Review" },
};

export const statusLabels: Record<EmployeeStatus, string> = {
  offline: "Offline", starting: "Starting", idle: "Available", planning: "Planning", working: "Building", waiting: "Needs you",
  review: "Reviewing", done: "Shipped", failed: "Blocked",
};

export const runtimeStatusLabels: Record<RuntimeStatus, string> = {
  not_provisioned: "Not provisioned", created: "Created", running: "Running",
  paused: "Paused", restarting: "Restarting", removing: "Removing",
  exited: "Stopped", dead: "Failed", not_found: "Missing",
};

export function mapDockerStatus(status: RuntimeStatus, current: EmployeeStatus): EmployeeStatus {
  if (status === "running") {
    return ["planning", "working", "waiting", "review", "done", "failed"].includes(current) ? current : "idle";
  }
  if (status === "created" || status === "restarting") return "starting";
  if (status === "paused") return "waiting";
  if (status === "dead") return "failed";
  if (["not_provisioned", "removing", "exited", "not_found"].includes(status)) return "offline";
  return current;
}
