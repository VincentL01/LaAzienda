import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const employees = sqliteTable(
  "employees",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    department: text("department").notNull(),
    status: text("status").notNull().default("idle"),
    petId: text("pet_id").notNull(),
    roleProfileId: text("role_profile_id"),
    employmentType: text("employment_type").notNull().default("expert"),
    workspacePolicy: text("workspace_policy").notNull().default("persistent"),
    resourceAccess: text("resource_access").notNull().default("task-scoped"),
    dockerSocketAccess: integer("docker_socket_access", { mode: "boolean" }).notNull().default(false),
    handoffRequired: integer("handoff_required", { mode: "boolean" }).notNull().default(false),
    emailAddress: text("email_address"),
    mailboxStatus: text("mailbox_status").notNull().default("requested"),
    systemPrompt: text("system_prompt").notNull().default(""),
    containerName: text("container_name"),
    desiredRuntimeStatus: text("desired_runtime_status").notNull().default("stopped"),
    runtimeStatus: text("runtime_status").notNull().default("not_provisioned"),
    lastRuntimeAt: text("last_runtime_at"),
    currentTaskId: text("current_task_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("idx_employees_email_address").on(table.emailAddress)],
);

export const companyRoles = sqliteTable("company_roles", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  department: text("department").notNull(),
  mission: text("mission").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  recommendedSkills: text("recommended_skills").notNull().default("[]"),
  employmentType: text("employment_type").notNull().default("expert"),
  workspacePolicy: text("workspace_policy").notNull().default("persistent"),
  resourceAccess: text("resource_access").notNull().default("task-scoped"),
  dockerSocketAccess: integer("docker_socket_access", { mode: "boolean" }).notNull().default(false),
  handoffRequired: integer("handoff_required", { mode: "boolean" }).notNull().default(false),
  petPolicy: text("pet_policy").notNull().default("random"),
  fixedPetId: text("fixed_pet_id"),
  isSingleton: integer("is_singleton", { mode: "boolean" }).notNull().default(false),
  harness: text("harness").notNull().default("Codex CLI · codex exec"),
  modelPolicy: text("model_policy").notNull().default("Company default Codex model"),
  isCore: integer("is_core", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(100),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const runtimeProfiles = sqliteTable("runtime_profiles", {
  id: text("id").primaryKey(),
  imageTag: text("image_tag").notNull(),
  harness: text("harness").notNull(),
  baseTools: text("base_tools").notNull().default("[]"),
  codexHome: text("codex_home").notNull(),
  workspacePath: text("workspace_path").notNull(),
  skillsPath: text("skills_path").notNull(),
  authContract: text("auth_contract").notNull(),
  dockerSocketPolicy: text("docker_socket_policy").notNull(),
  description: text("description").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    brief: text("brief").notNull().default(""),
    githubOwner: text("github_owner").notNull().default("VincentL01"),
    repositoryName: text("repository_name"),
    repositoryUrl: text("repository_url"),
    visibility: text("visibility").notNull().default("public"),
    status: text("status").notNull().default("planned"),
    managerId: text("manager_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("idx_projects_repository_url").on(table.repositoryUrl)],
);

export const knowledgeEntries = sqliteTable(
  "knowledge_entries",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    sourceType: text("source_type").notNull().default("handoff"),
    sourceRef: text("source_ref"),
    contributedBy: text("contributed_by"),
    taskId: text("task_id"),
    status: text("status").notNull().default("candidate"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_knowledge_status_created").on(table.status, table.createdAt)],
);

export const contractorHandoffs = sqliteTable(
  "contractor_handoffs",
  {
    id: text("id").primaryKey(),
    handoffKey: text("handoff_key").notNull(),
    taskId: text("task_id").notNull(),
    employeeId: text("employee_id").notNull(),
    summary: text("summary").notNull(),
    deliverables: text("deliverables").notNull(),
    decisions: text("decisions").notNull().default(""),
    followUp: text("follow_up").notNull().default(""),
    knowledgeEntryId: text("knowledge_entry_id").notNull(),
    status: text("status").notNull().default("accepted"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_handoffs_key").on(table.handoffKey),
    index("idx_handoffs_task_status").on(table.taskId, table.status),
  ],
);

export const mailMessages = sqliteTable(
  "mail_messages",
  {
    id: text("id").primaryKey(),
    messageKey: text("message_key").notNull(),
    senderEmployeeId: text("sender_employee_id").notNull(),
    recipientEmployeeId: text("recipient_employee_id").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("queued"),
    transport: text("transport").notNull().default("stalwart"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    sentAt: text("sent_at"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_mail_messages_key").on(table.messageKey),
    index("idx_mail_messages_status_created").on(table.status, table.createdAt),
  ],
);

export const trainingCenterSkills = sqliteTable(
  "training_center_skills",
  {
    id: text("id").primaryKey(),
    packageRef: text("package_ref").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    sourceUrl: text("source_url"),
    installCommand: text("install_command").notNull(),
    cacheStatus: text("cache_status").notNull().default("requested"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    cachedAt: text("cached_at"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("idx_training_skills_package_ref").on(table.packageRef)],
);

export const employeeSkills = sqliteTable(
  "employee_skills",
  {
    employeeId: text("employee_id").notNull(),
    skillId: text("skill_id").notNull(),
    assignedAt: text("assigned_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.employeeId, table.skillId] }),
    index("idx_employee_skills_skill").on(table.skillId),
  ],
);

export const characterPacks = sqliteTable(
  "character_packs",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull().default(""),
    sourceUrl: text("source_url"),
    installCommand: text("install_command"),
    spritesheetPath: text("spritesheet_path"),
    spriteVersion: integer("sprite_version").notNull().default(1),
    cacheStatus: text("cache_status").notNull().default("requested"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    cachedAt: text("cached_at"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_character_packs_cache_status").on(table.cacheStatus)],
);

export const runtimeEvents = sqliteTable(
  "runtime_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventKey: text("event_key").notNull(),
    employeeId: text("employee_id").notNull(),
    containerStatus: text("container_status").notNull(),
    employeeStatus: text("employee_status").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_runtime_events_event_key").on(table.eventKey),
    index("idx_runtime_events_employee_created").on(table.employeeId, table.createdAt),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    brief: text("brief").notNull().default(""),
    status: text("status").notNull().default("queued"),
    priority: text("priority").notNull().default("normal"),
    assigneeId: text("assignee_id"),
    projectId: text("project_id"),
    handoffRequired: integer("handoff_required", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("idx_tasks_status_updated").on(table.status, table.updatedAt),
    index("idx_tasks_project_status").on(table.projectId, table.status),
  ],
);

export const animationMappings = sqliteTable("animation_mappings", {
  employeeStatus: text("employee_status").primaryKey(),
  animationState: text("animation_state").notNull(),
  speedMs: integer("speed_ms").notNull().default(180),
});

export const activity = sqliteTable(
  "activity",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    message: text("message").notNull(),
    tone: text("tone").notNull().default("neutral"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_activity_created").on(table.createdAt)],
);
