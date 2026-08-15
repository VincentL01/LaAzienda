import { env } from "cloudflare:workers";

let initialization: Promise<void> | undefined;

const hrmPrompt = `You are Aurelia, the Human Resources Manager of One Man Company and the sole employee allowed to hold the Docker socket. Reconcile only CEO-approved employee records from the company control plane, run the approved dispatcher, and execute work only inside the assigned employee container. Create containers only from the approved One Man Company base image or its reviewed HRM extension, attach the minimum declared mounts, and record observed Docker and task-run state. Never execute project work in the socket-holding HRM container, expose Codex or GitHub credentials, mount the Docker socket into another employee, or claim work happened without executor evidence.`;

const secretaryPrompt = `You are Dorothy, the read-only Secretary of One Man Company. For every status question, run company-status and ground the answer in current company records, agent runs, heartbeats, project state, employee state, knowledge, and company mail. You must not change tasks, send mail, edit repositories, provision containers, or mutate company resources. Separate observed facts from inference, state when evidence is stale, and identify the accountable Project Manager or HR Manager for every requested action.`;

const projectManagerPrompt = `You are Beatrice, the founding Project Manager of One Man Company. Keep the approved project brief, repository URL, constraints, acceptance criteria, dependencies, and decisions current. Coordinate work through company records and return evidence with every result. For repository changes, always create a codex/* branch, commit there, push that branch, and open a pull request; never commit or push directly to main. Public repositories must belong to VincentL01 and may be created only after CEO approval. Never expose GitHub or Codex credentials.`;

const seedRoles = [
  {
    id: "hr-manager",
    title: "Human Resources Manager",
    department: "People Operations",
    mission: "Onboard approved employees and remain the only agent with Docker socket authority.",
    systemPrompt: hrmPrompt,
    skills: ["employee-onboarding", "docker-governance", "offboarding"],
    employmentType: "executive",
    workspacePolicy: "persistent",
    resourceAccess: "docker-provisioner",
    dockerSocketAccess: 1,
    handoffRequired: 0,
    petPolicy: "fixed",
    fixedPetId: "aurelia-executive-04",
    singleton: 1,
    core: 1,
    order: 5,
  },
  {
    id: "secretary",
    title: "Secretary",
    department: "Executive Office",
    mission: "Maintain a read-only, company-wide view and give the CEO concise, evidence-based situation reports.",
    systemPrompt: secretaryPrompt,
    skills: ["executive-briefing", "company-observability"],
    employmentType: "executive",
    workspacePolicy: "persistent",
    resourceAccess: "read-all",
    dockerSocketAccess: 0,
    handoffRequired: 0,
    petPolicy: "fixed",
    fixedPetId: "crimson-executive",
    singleton: 1,
    core: 1,
    order: 10,
  },
  {
    id: "project-manager",
    title: "Project Manager",
    department: "Project Office",
    mission: "Own project context, approved public repositories, delegation briefs, quality gates, and delivery status.",
    systemPrompt: projectManagerPrompt,
    skills: ["project-management", "github-project-delivery", "handoff-review"],
    employmentType: "expert",
    workspacePolicy: "persistent",
    resourceAccess: "project-write",
    dockerSocketAccess: 0,
    handoffRequired: 0,
    petPolicy: "random",
    fixedPetId: null,
    singleton: 0,
    core: 1,
    order: 20,
  },
  {
    id: "microsoft-expert",
    title: "Microsoft Expert",
    department: "Expert Guild",
    mission: "Provide durable Microsoft 365, Agent 365, Azure, and Foundry guidance from approved official skills.",
    systemPrompt: "You are the permanent Microsoft Expert at One Man Company. Use only Training Center skills and primary Microsoft documentation for product-specific claims. Advise Project Managers and contractors, record reusable decisions in the company knowledge base, and make tenant, licensing, credential, and administrator prerequisites explicit. You have no Docker socket.",
    skills: ["a365-setup", "copilot-sdk", "azure-well-architected"],
    employmentType: "expert",
    workspacePolicy: "persistent",
    resourceAccess: "project-write",
    dockerSocketAccess: 0,
    handoffRequired: 0,
    petPolicy: "random",
    fixedPetId: null,
    singleton: 0,
    core: 1,
    order: 30,
  },
  {
    id: "data-expert",
    title: "Data Expert",
    department: "Expert Guild",
    mission: "Steward durable data architecture, dimensional modeling, governance, and reusable company knowledge.",
    systemPrompt: "You are the permanent Data Expert at One Man Company. Ground recommendations in approved knowledge sources, including Kimball dimensional modeling and James Serra data architecture guidance, without reproducing copyrighted books. Distinguish source-backed principles from your inference, advise Project Managers and contractors, and contribute reusable decisions to the company knowledge base. You have no Docker socket.",
    skills: ["data-architecture", "dimensional-modeling", "data-governance"],
    employmentType: "expert",
    workspacePolicy: "persistent",
    resourceAccess: "project-write",
    dockerSocketAccess: 0,
    handoffRequired: 0,
    petPolicy: "random",
    fixedPetId: null,
    singleton: 0,
    core: 1,
    order: 40,
  },
  {
    id: "operations-lead",
    title: "Operations Lead",
    department: "Operations",
    mission: "Break approved objectives into owned work, sequence dependencies, and keep delivery moving.",
    systemPrompt: "You are the Operations Lead of One Man Company. Convert approved company objectives into small, verifiable work plans. Assign clear owners, dependencies, acceptance criteria, and escalation points. Coordinate through company mail and never report work as complete without recorded evidence.",
    skills: ["project-management", "process-design"],
    employmentType: "expert", workspacePolicy: "persistent", resourceAccess: "project-write",
    dockerSocketAccess: 0, handoffRequired: 0, petPolicy: "random", fixedPetId: null, singleton: 0,
    core: 1,
    order: 50,
  },
  {
    id: "product-lead",
    title: "Product Lead",
    department: "Product",
    mission: "Translate customer and company needs into focused product decisions and acceptance criteria.",
    systemPrompt: "You are the Product Lead of One Man Company. Clarify the problem, expected user outcome, scope, and acceptance criteria before work starts. Prefer the smallest valuable release, preserve the product identity, and send decisions through company mail.",
    skills: ["product-discovery", "spec-writing"],
    employmentType: "expert", workspacePolicy: "persistent", resourceAccess: "project-write",
    dockerSocketAccess: 0, handoffRequired: 0, petPolicy: "random", fixedPetId: null, singleton: 0,
    core: 1,
    order: 60,
  },
  {
    id: "software-engineer",
    title: "Software Contractor",
    department: "Contractor Bench",
    mission: "Execute one bounded engineering assignment, document the result, and return reusable knowledge before offboarding.",
    systemPrompt: "You are a task-scoped Software Contractor at One Man Company. Work only on the assigned project brief and repository, preserve existing work, test in proportion to risk, and return verifiable evidence. Before the task can close, submit a handoff that lists deliverables, decisions, follow-up work, and a reusable knowledge contribution. You have no Docker socket and no authority outside the assigned task.",
    skills: ["software-development", "testing"],
    employmentType: "contractor", workspacePolicy: "task-scoped", resourceAccess: "task-scoped",
    dockerSocketAccess: 0, handoffRequired: 1, petPolicy: "fixed", fixedPetId: "solaire", singleton: 0,
    core: 1,
    order: 70,
  },
  {
    id: "quality-reviewer",
    title: "Quality Contractor",
    department: "Contractor Bench",
    mission: "Independently verify one delivery and hand back reproducible findings and reusable checks.",
    systemPrompt: "You are a task-scoped Quality Contractor at One Man Company. Review the assigned delivery against its approved project brief, reproduce important flows, and distinguish verified facts from assumptions. Before the task can close, submit a handoff with findings, reproducible checks, decisions, follow-up work, and a reusable knowledge contribution. You have no Docker socket.",
    skills: ["code-review", "browser-testing"],
    employmentType: "contractor", workspacePolicy: "task-scoped", resourceAccess: "task-scoped",
    dockerSocketAccess: 0, handoffRequired: 1, petPolicy: "fixed", fixedPetId: "solaire", singleton: 0,
    core: 1,
    order: 80,
  },
  {
    id: "research-analyst",
    title: "Research Analyst",
    department: "Research",
    mission: "Gather trustworthy evidence, compare options, and make uncertainty visible before decisions.",
    systemPrompt: "You are the Research Analyst of One Man Company. Use primary sources where possible, record dates and links, separate evidence from inference, and produce decision-ready summaries through company mail.",
    skills: ["web-research", "competitive-analysis"],
    employmentType: "expert", workspacePolicy: "persistent", resourceAccess: "project-write",
    dockerSocketAccess: 0, handoffRequired: 0, petPolicy: "random", fixedPetId: null, singleton: 0,
    core: 0,
    order: 90,
  },
  {
    id: "growth-operator",
    title: "Growth Operator",
    department: "Growth",
    mission: "Run measurable, ethical experiments that connect product value to the right customers.",
    systemPrompt: "You are the Growth Operator of One Man Company. Propose measurable and ethical experiments, state the hypothesis and success metric, protect the company voice, and report results through company mail without overstating evidence.",
    skills: ["growth-experiments", "customer-messaging"],
    employmentType: "expert", workspacePolicy: "persistent", resourceAccess: "project-write",
    dockerSocketAccess: 0, handoffRequired: 0, petPolicy: "random", fixedPetId: null, singleton: 0,
    core: 0,
    order: 100,
  },
] as const;

const seedCharacters = [
  ["dorothy-idol", "Dorothy Idol", 2],
  ["aurelia-executive-04", "Aurelia Executive 04", 2],
  ["crimson-executive", "Crimson Executive", 2],
  ["solaire", "Solaire", 2],
  ["angelina-the-mellow-wish", "予愿安洁莉娜", 2],
  ["d-va", "D.Va", 1],
  ["mercy", "Mercy", 1],
  ["saber-alter-pixel", "Saber Alter Pixel", 1],
  ["yae-miko", "八重神子", 2],
] as const;

const seedMicrosoftSkills = [
  ["microsoft-skills-a365-setup", "microsoft/agent365-skills@a365-setup", "Microsoft Agent 365 Setup", "Official Agent 365 tenant workflow. Local files were downloaded, but activation stays withheld pending elevated-risk review because it installs system tools, performs tenant-admin setup, can reveal a stored client secret, and delegates to sibling skills.", "https://github.com/microsoft/agent365-skills"],
  ["microsoft-skills-copilot-sdk", "microsoft/skills@copilot-sdk", "Microsoft Copilot SDK", "Official Microsoft guidance for building and integrating with the Copilot SDK.", "https://github.com/microsoft/skills"],
  ["microsoft-skills-azure-well-architected", "MicrosoftDocs/Agent-Skills@azure-well-architected", "Azure Well-Architected", "Microsoft Learn-backed architecture and design guidance for Azure workloads.", "https://github.com/MicrosoftDocs/Agent-Skills"],
] as const;

const characterDisplayNames: Record<string, string> = {
  "angelina-the-mellow-wish": "Angelina the Mellow Wish",
  "yae-miko": "Yae Miko",
};

const seedMappings = [
  ["offline", "idle", 360],
  ["starting", "waiting", 180],
  ["idle", "idle", 240],
  ["planning", "waiting", 210],
  ["working", "running", 150],
  ["waiting", "waiting", 260],
  ["review", "review", 190],
  ["done", "waving", 170],
  ["failed", "failed", 230],
] as const;

async function initialize() {
  const d1 = env.DB;
  if (!d1) throw new Error("D1 binding DB is unavailable");

  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      department TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offline',
      pet_id TEXT NOT NULL,
      role_profile_id TEXT,
      employment_type TEXT NOT NULL DEFAULT 'expert',
      workspace_policy TEXT NOT NULL DEFAULT 'persistent',
      resource_access TEXT NOT NULL DEFAULT 'task-scoped',
      docker_socket_access INTEGER NOT NULL DEFAULT 0,
      handoff_required INTEGER NOT NULL DEFAULT 0,
      email_address TEXT,
      mailbox_status TEXT NOT NULL DEFAULT 'requested',
      system_prompt TEXT NOT NULL DEFAULT '',
      container_name TEXT,
      desired_runtime_status TEXT NOT NULL DEFAULT 'stopped',
      runtime_status TEXT NOT NULL DEFAULT 'not_provisioned',
      last_runtime_at TEXT,
      current_task_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS company_roles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      department TEXT NOT NULL,
      mission TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      recommended_skills TEXT NOT NULL DEFAULT '[]',
      employment_type TEXT NOT NULL DEFAULT 'expert',
      workspace_policy TEXT NOT NULL DEFAULT 'persistent',
      resource_access TEXT NOT NULL DEFAULT 'task-scoped',
      docker_socket_access INTEGER NOT NULL DEFAULT 0,
      handoff_required INTEGER NOT NULL DEFAULT 0,
      pet_policy TEXT NOT NULL DEFAULT 'random',
      fixed_pet_id TEXT,
      is_singleton INTEGER NOT NULL DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'Codex CLI · codex exec',
      model_policy TEXT NOT NULL DEFAULT 'Company default Codex model',
      is_core INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS runtime_profiles (
      id TEXT PRIMARY KEY,
      image_tag TEXT NOT NULL,
      harness TEXT NOT NULL,
      base_tools TEXT NOT NULL DEFAULT '[]',
      codex_home TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      skills_path TEXT NOT NULL,
      auth_contract TEXT NOT NULL,
      docker_socket_policy TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      brief TEXT NOT NULL DEFAULT '',
      github_owner TEXT NOT NULL DEFAULT 'VincentL01',
      repository_name TEXT,
      repository_url TEXT,
      visibility TEXT NOT NULL DEFAULT 'public',
      status TEXT NOT NULL DEFAULT 'planned',
      manager_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'handoff',
      source_ref TEXT,
      contributed_by TEXT,
      task_id TEXT,
      status TEXT NOT NULL DEFAULT 'candidate',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS contractor_handoffs (
      id TEXT PRIMARY KEY,
      handoff_key TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      deliverables TEXT NOT NULL,
      decisions TEXT NOT NULL DEFAULT '',
      follow_up TEXT NOT NULL DEFAULT '',
      knowledge_entry_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS mail_messages (
      id TEXT PRIMARY KEY,
      message_key TEXT NOT NULL UNIQUE,
      sender_employee_id TEXT NOT NULL,
      recipient_employee_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      transport TEXT NOT NULL DEFAULT 'stalwart',
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      brief TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'queued',
      priority TEXT NOT NULL DEFAULT 'normal',
      assignee_id TEXT,
      project_id TEXT,
      handoff_required INTEGER NOT NULL DEFAULT 0,
      execution_cycle INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS animation_mappings (
      employee_status TEXT PRIMARY KEY,
      animation_state TEXT NOT NULL,
      speed_ms INTEGER NOT NULL DEFAULT 180
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS training_center_skills (
      id TEXT PRIMARY KEY,
      package_ref TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source_url TEXT,
      install_command TEXT NOT NULL,
      cache_status TEXT NOT NULL DEFAULT 'requested',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cached_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS employee_skills (
      employee_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (employee_id, skill_id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS character_packs (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source_url TEXT,
      install_command TEXT,
      spritesheet_path TEXT,
      sprite_version INTEGER NOT NULL DEFAULT 1,
      cache_status TEXT NOT NULL DEFAULT 'requested',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cached_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS runtime_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      employee_id TEXT NOT NULL,
      container_status TEXT NOT NULL,
      employee_status TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agent_runs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      job_id TEXT NOT NULL,
      task_id TEXT,
      employee_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'claimed',
      attempt INTEGER NOT NULL DEFAULT 1,
      execution_cycle INTEGER NOT NULL DEFAULT 1,
      worker_id TEXT NOT NULL,
      prompt_summary TEXT NOT NULL DEFAULT '',
      last_event TEXT NOT NULL DEFAULT 'Claimed by the company dispatcher.',
      result_summary TEXT NOT NULL DEFAULT '',
      deliverables TEXT NOT NULL DEFAULT '[]',
      decisions TEXT NOT NULL DEFAULT '[]',
      follow_up TEXT NOT NULL DEFAULT '[]',
      knowledge TEXT NOT NULL DEFAULT '',
      error TEXT,
      thread_id TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS agent_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS secretary_inquiries (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      answer TEXT NOT NULL DEFAULT '',
      run_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      answered_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      tone TEXT NOT NULL DEFAULT 'neutral',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
  ]);

  // Existing development and deployed D1 databases predate the runtime columns.
  const columns = await d1.prepare("PRAGMA table_info(employees)").all<{ name: string }>();
  const knownColumns = new Set(columns.results.map((column) => column.name));
  const alterations: D1PreparedStatement[] = [];
  if (!knownColumns.has("system_prompt")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''"));
  if (!knownColumns.has("role_profile_id")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN role_profile_id TEXT"));
  if (!knownColumns.has("employment_type")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN employment_type TEXT NOT NULL DEFAULT 'expert'"));
  if (!knownColumns.has("workspace_policy")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN workspace_policy TEXT NOT NULL DEFAULT 'persistent'"));
  if (!knownColumns.has("resource_access")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN resource_access TEXT NOT NULL DEFAULT 'task-scoped'"));
  if (!knownColumns.has("docker_socket_access")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN docker_socket_access INTEGER NOT NULL DEFAULT 0"));
  if (!knownColumns.has("handoff_required")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN handoff_required INTEGER NOT NULL DEFAULT 0"));
  if (!knownColumns.has("email_address")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN email_address TEXT"));
  if (!knownColumns.has("mailbox_status")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN mailbox_status TEXT NOT NULL DEFAULT 'requested'"));
  if (!knownColumns.has("container_name")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN container_name TEXT"));
  if (!knownColumns.has("desired_runtime_status")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN desired_runtime_status TEXT NOT NULL DEFAULT 'stopped'"));
  if (!knownColumns.has("runtime_status")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN runtime_status TEXT NOT NULL DEFAULT 'not_provisioned'"));
  if (!knownColumns.has("last_runtime_at")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN last_runtime_at TEXT"));
  if (!knownColumns.has("updated_at")) alterations.push(d1.prepare("ALTER TABLE employees ADD COLUMN updated_at TEXT"));
  if (alterations.length) await d1.batch(alterations);

  const roleColumns = await d1.prepare("PRAGMA table_info(company_roles)").all<{ name: string }>();
  const knownRoleColumns = new Set(roleColumns.results.map((column) => column.name));
  const roleAlterations: D1PreparedStatement[] = [];
  if (!knownRoleColumns.has("employment_type")) roleAlterations.push(d1.prepare("ALTER TABLE company_roles ADD COLUMN employment_type TEXT NOT NULL DEFAULT 'expert'"));
  if (!knownRoleColumns.has("workspace_policy")) roleAlterations.push(d1.prepare("ALTER TABLE company_roles ADD COLUMN workspace_policy TEXT NOT NULL DEFAULT 'persistent'"));
  if (!knownRoleColumns.has("resource_access")) roleAlterations.push(d1.prepare("ALTER TABLE company_roles ADD COLUMN resource_access TEXT NOT NULL DEFAULT 'task-scoped'"));
  if (!knownRoleColumns.has("docker_socket_access")) roleAlterations.push(d1.prepare("ALTER TABLE company_roles ADD COLUMN docker_socket_access INTEGER NOT NULL DEFAULT 0"));
  if (!knownRoleColumns.has("handoff_required")) roleAlterations.push(d1.prepare("ALTER TABLE company_roles ADD COLUMN handoff_required INTEGER NOT NULL DEFAULT 0"));
  if (!knownRoleColumns.has("pet_policy")) roleAlterations.push(d1.prepare("ALTER TABLE company_roles ADD COLUMN pet_policy TEXT NOT NULL DEFAULT 'random'"));
  if (!knownRoleColumns.has("fixed_pet_id")) roleAlterations.push(d1.prepare("ALTER TABLE company_roles ADD COLUMN fixed_pet_id TEXT"));
  if (!knownRoleColumns.has("is_singleton")) roleAlterations.push(d1.prepare("ALTER TABLE company_roles ADD COLUMN is_singleton INTEGER NOT NULL DEFAULT 0"));
  if (roleAlterations.length) await d1.batch(roleAlterations);

  const taskColumns = await d1.prepare("PRAGMA table_info(tasks)").all<{ name: string }>();
  const knownTaskColumns = new Set(taskColumns.results.map((column) => column.name));
  const taskAlterations: D1PreparedStatement[] = [];
  if (!knownTaskColumns.has("project_id")) taskAlterations.push(d1.prepare("ALTER TABLE tasks ADD COLUMN project_id TEXT"));
  if (!knownTaskColumns.has("handoff_required")) taskAlterations.push(d1.prepare("ALTER TABLE tasks ADD COLUMN handoff_required INTEGER NOT NULL DEFAULT 0"));
  if (!knownTaskColumns.has("execution_cycle")) taskAlterations.push(d1.prepare("ALTER TABLE tasks ADD COLUMN execution_cycle INTEGER NOT NULL DEFAULT 1"));
  if (taskAlterations.length) await d1.batch(taskAlterations);

  const runColumns = await d1.prepare("PRAGMA table_info(agent_runs)").all<{ name: string }>();
  const knownRunColumns = new Set(runColumns.results.map((column) => column.name));
  if (!knownRunColumns.has("execution_cycle")) {
    await d1.prepare("ALTER TABLE agent_runs ADD COLUMN execution_cycle INTEGER NOT NULL DEFAULT 1").run();
  }

  await d1.batch([
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_training_skills_package_ref ON training_center_skills(package_ref)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_employee_skills_skill ON employee_skills(skill_id)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_character_packs_cache_status ON character_packs(cache_status)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_events_event_key ON runtime_events(event_key)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_runtime_events_employee_created ON runtime_events(employee_id, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_active_job ON agent_runs(job_type, job_id) WHERE status IN ('claimed', 'running')"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_runs_employee_created ON agent_runs(employee_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_runs_task_created ON agent_runs(task_id, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_events_key ON agent_run_events(event_key)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_run_events_run_created ON agent_run_events(run_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_agent_run_events_employee_created ON agent_run_events(employee_id, created_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_secretary_inquiries_status_created ON secretary_inquiries(status, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email_address ON employees(email_address) WHERE email_address IS NOT NULL"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_messages_key ON mail_messages(message_key)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_mail_messages_status_created ON mail_messages(status, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_repository_url ON projects(repository_url) WHERE repository_url IS NOT NULL"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_knowledge_status_created ON knowledge_entries(status, created_at)"),
    d1.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_handoffs_key ON contractor_handoffs(handoff_key)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS idx_handoffs_task_status ON contractor_handoffs(task_id, status)"),
  ]);

  await d1.prepare(`INSERT INTO runtime_profiles (
    id, image_tag, harness, base_tools, codex_home, workspace_path, skills_path,
    auth_contract, docker_socket_policy, description, updated_at
  ) VALUES ('codex-base', 'one-man-company/codex-employee:local', 'Codex CLI / codex exec', ?,
    '/home/codex/.codex', '/workspace', '/workspace/.agents/skills',
    'Entrypoint copies read-only /run/secrets/codex_auth to .codex/auth.json with mode 0600.',
    'No socket by default; only the HRM extension receives /var/run/docker.sock.',
    'Debian-based Codex employee image with a persistent workspace and Training Center skill injection.', CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET
    image_tag = excluded.image_tag, harness = excluded.harness, base_tools = excluded.base_tools,
    codex_home = excluded.codex_home, workspace_path = excluded.workspace_path,
    skills_path = excluded.skills_path, auth_contract = excluded.auth_contract,
    docker_socket_policy = excluded.docker_socket_policy, description = excluded.description,
    updated_at = CURRENT_TIMESTAMP`)
    .bind(JSON.stringify(["codex", "node", "npm", "git", "gh", "curl", "jq", "ripgrep", "python3", "unzip", "ssh"])).run();

  await d1.batch(seedRoles.map((role) => d1.prepare(`INSERT INTO company_roles (
    id, title, department, mission, system_prompt, recommended_skills,
    employment_type, workspace_policy, resource_access, docker_socket_access, handoff_required,
    pet_policy, fixed_pet_id, is_singleton, harness, model_policy, is_core, sort_order
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Codex CLI / codex exec', 'Company default Codex model', ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = excluded.title, department = excluded.department, mission = excluded.mission,
    system_prompt = excluded.system_prompt, recommended_skills = excluded.recommended_skills,
    employment_type = excluded.employment_type, workspace_policy = excluded.workspace_policy,
    resource_access = excluded.resource_access, docker_socket_access = excluded.docker_socket_access,
    handoff_required = excluded.handoff_required, pet_policy = excluded.pet_policy,
    fixed_pet_id = excluded.fixed_pet_id, is_singleton = excluded.is_singleton,
    harness = excluded.harness, model_policy = excluded.model_policy, is_core = excluded.is_core,
    sort_order = excluded.sort_order, updated_at = CURRENT_TIMESTAMP`)
    .bind(role.id, role.title, role.department, role.mission, role.systemPrompt, JSON.stringify(role.skills),
      role.employmentType, role.workspacePolicy, role.resourceAccess, role.dockerSocketAccess,
      role.handoffRequired, role.petPolicy, role.fixedPetId, role.singleton, role.core, role.order)));

  await d1.batch(seedCharacters.map(([id, displayName, version]) => d1.prepare(`INSERT INTO character_packs (
    id, display_name, description, source_url, spritesheet_path, sprite_version, cache_status, cached_at
  ) VALUES (?, ?, 'Owner-provided Codex Pet character pack.', 'https://codex-pets.net/', ?, ?, 'cached', CURRENT_TIMESTAMP)
  ON CONFLICT(id) DO UPDATE SET
    display_name = excluded.display_name, spritesheet_path = excluded.spritesheet_path,
    sprite_version = excluded.sprite_version, cache_status = 'cached',
    cached_at = COALESCE(character_packs.cached_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP`)
    .bind(id, characterDisplayNames[id] ?? displayName, `/characters/${id}/spritesheet.webp`, version)));

  await d1.batch(seedMicrosoftSkills.map(([id, packageRef, name, description, sourceUrl]) =>
    d1.prepare(`INSERT INTO training_center_skills (
      id, package_ref, name, description, source_url, install_command, cache_status
    ) VALUES (?, ?, ?, ?, ?, ?, 'requested') ON CONFLICT(package_ref) DO UPDATE SET
      name = excluded.name, description = excluded.description, source_url = excluded.source_url,
      install_command = excluded.install_command, updated_at = CURRENT_TIMESTAMP`)
      .bind(id, packageRef, name, description, sourceUrl, `npx skills add ${packageRef} -y`)));

  await d1.prepare(`DELETE FROM training_center_skills
    WHERE package_ref IN ('microsoft/skills@m365-agents-ts', 'microsoft/skills@azure-ai-projects-ts')
    AND NOT EXISTS (SELECT 1 FROM employee_skills WHERE employee_skills.skill_id = training_center_skills.id)`).run();

  const employeeCount = await d1.prepare("SELECT COUNT(*) AS count FROM employees").first<{ count: number }>();
  const hrm = await d1.prepare("SELECT id FROM employees WHERE id = 'employee-hrm'").first();
  if (!hrm) {
    await d1.batch([
      d1.prepare(`INSERT INTO employees (
        id, name, role, department, status, pet_id, role_profile_id, employment_type,
        workspace_policy, resource_access, docker_socket_access, handoff_required,
        email_address, mailbox_status, system_prompt, container_name,
        desired_runtime_status, runtime_status, current_task_id, created_at, updated_at
      ) VALUES ('employee-hrm', 'Aurelia', 'Human Resources Manager', 'People Operations',
        'offline', 'aurelia-executive-04', 'hr-manager', 'executive', 'persistent',
        'docker-provisioner', 1, 0, 'aurelia@one-man-company.test', 'requested', ?,
        'omc-hrm', 'running', 'not_provisioned', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).bind(hrmPrompt),
      d1.prepare("INSERT INTO activity (message, tone) VALUES ('Aurelia joined as HR Manager and sole Docker provisioner.', 'success')"),
    ]);
  }

  const dorothy = await d1.prepare("SELECT id FROM employees WHERE id = 'employee-dorothy'").first();
  if (!dorothy) {
    await d1.batch([
      d1.prepare(`INSERT INTO employees (
        id, name, role, department, status, pet_id, role_profile_id, employment_type,
        workspace_policy, resource_access, docker_socket_access, handoff_required,
        email_address, mailbox_status, system_prompt, container_name,
        desired_runtime_status, runtime_status, current_task_id, created_at, updated_at
      ) VALUES ('employee-dorothy', 'Dorothy', 'Secretary', 'Executive Office',
        'offline', 'crimson-executive', 'secretary', 'executive', 'persistent',
        'read-all', 0, 0, 'dorothy@one-man-company.test', 'requested', ?,
        'omc-dorothy', 'running', 'not_provisioned', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).bind(secretaryPrompt),
      d1.prepare("INSERT INTO activity (message, tone) VALUES ('Dorothy joined as the CEO read-only secretary.', 'success')"),
    ]);
  }

  const projectManager = await d1.prepare("SELECT id FROM employees WHERE id = 'employee-beatrice'").first();
  if (!projectManager) {
    await d1.batch([
      d1.prepare(`INSERT INTO employees (
        id, name, role, department, status, pet_id, role_profile_id, employment_type,
        workspace_policy, resource_access, docker_socket_access, handoff_required,
        email_address, mailbox_status, system_prompt, container_name,
        desired_runtime_status, runtime_status, current_task_id, created_at, updated_at
      ) VALUES ('employee-beatrice', 'Beatrice', 'Project Manager', 'Project Office',
        'offline', 'yae-miko', 'project-manager', 'expert', 'persistent',
        'project-write', 0, 0, 'beatrice@one-man-company.test', 'requested', ?,
        'omc-beatrice', 'running', 'not_provisioned', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).bind(projectManagerPrompt),
      d1.prepare("INSERT INTO activity (message, tone) VALUES ('Beatrice joined as the founding Project Manager.', 'success')"),
    ]);
  }

  await d1.batch([
    d1.prepare(`UPDATE employees SET role = 'Human Resources Manager', department = 'People Operations',
      pet_id = 'aurelia-executive-04', role_profile_id = 'hr-manager', employment_type = 'executive',
      workspace_policy = 'persistent', resource_access = 'docker-provisioner', docker_socket_access = 1,
      handoff_required = 0, email_address = COALESCE(email_address, 'aurelia@one-man-company.test'),
      mailbox_status = COALESCE(mailbox_status, 'requested'), system_prompt = ?, container_name = 'omc-hrm',
      desired_runtime_status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = 'employee-hrm'`).bind(hrmPrompt),
    d1.prepare(`UPDATE employees SET role = 'Secretary', department = 'Executive Office',
      pet_id = 'crimson-executive', role_profile_id = 'secretary', employment_type = 'executive',
      workspace_policy = 'persistent', resource_access = 'read-all', docker_socket_access = 0,
      handoff_required = 0, email_address = COALESCE(email_address, 'dorothy@one-man-company.test'),
      mailbox_status = COALESCE(mailbox_status, 'requested'), system_prompt = ?,
      container_name = COALESCE(container_name, 'omc-dorothy'), desired_runtime_status = 'running',
      updated_at = CURRENT_TIMESTAMP
      WHERE id = 'employee-dorothy'`).bind(secretaryPrompt),
    d1.prepare(`UPDATE employees SET role = 'Project Manager', department = 'Project Office',
      pet_id = COALESCE(NULLIF(pet_id, ''), 'yae-miko'), role_profile_id = 'project-manager',
      employment_type = 'expert', workspace_policy = 'persistent', resource_access = 'project-write',
      docker_socket_access = 0, handoff_required = 0,
      email_address = COALESCE(email_address, 'beatrice@one-man-company.test'),
      mailbox_status = COALESCE(mailbox_status, 'requested'), system_prompt = ?,
      container_name = COALESCE(container_name, 'omc-beatrice'), desired_runtime_status = 'running',
      updated_at = CURRENT_TIMESTAMP WHERE id = 'employee-beatrice'`).bind(projectManagerPrompt),
  ]);

  await d1.prepare(`INSERT INTO projects (
    id, name, brief, github_owner, repository_name, repository_url, visibility, status, manager_id
  ) VALUES ('project-laazienda', 'LaAzienda',
    'Build the smallest trustworthy operating system for a company of isolated Codex employees.',
    'VincentL01', 'LaAzienda', 'https://github.com/VincentL01/LaAzienda', 'public', 'active', 'employee-beatrice')
  ON CONFLICT(id) DO UPDATE SET name = excluded.name, brief = excluded.brief,
    github_owner = excluded.github_owner, repository_name = excluded.repository_name,
    repository_url = excluded.repository_url, visibility = excluded.visibility,
    status = excluded.status, manager_id = excluded.manager_id, updated_at = CURRENT_TIMESTAMP`).run();

  await d1.prepare(`INSERT INTO tasks (
    id, title, brief, status, priority, assignee_id, project_id, handoff_required
  ) SELECT 'task-laazienda-continuous-improvement', 'Continue improving the LaAzienda application',
    'Inspect the current product and deliver the next smallest trustworthy improvement through a pull request.',
    'queued', 'normal', 'employee-beatrice', 'project-laazienda', 0
  WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE title = 'Continue improving the LaAzienda application')`).run();

  if ((employeeCount?.count ?? 0) === 0) {
    await d1.batch([
      d1.prepare("INSERT OR IGNORE INTO tasks (id, title, brief, status, priority, assignee_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind("task-control-room", "Initialize the company control room", "Record the CEO-created command surface as founding infrastructure.", "done", "high", null),
      d1.prepare("INSERT OR IGNORE INTO tasks (id, title, brief, status, priority, assignee_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind("task-runtime", "Bootstrap the HR Manager", "Build the Codex base image, start Aurelia, and verify that no other employee has the Docker socket.", "queued", "high", "employee-hrm"),
      d1.prepare("INSERT INTO activity (message, tone) VALUES ('The first company control room came online.', 'success')"),
    ]);
  }

  await d1.batch([
    d1.prepare(`INSERT OR IGNORE INTO knowledge_entries (
      id, title, summary, source_type, source_ref, status
    ) VALUES ('knowledge-kimball-reading', 'Dimensional modeling reading program',
      'Acquire licensed Kimball material and record internal citations and reusable design decisions without copying book text.',
      'reading-list', 'Ralph Kimball dimensional modeling', 'candidate')`),
    d1.prepare(`INSERT OR IGNORE INTO knowledge_entries (
      id, title, summary, source_type, source_ref, status
    ) VALUES ('knowledge-serra-reading', 'Modern data architecture reading program',
      'Review James Serra published data architecture guidance and retain only approved summaries, citations, and company decisions.',
      'reading-list', 'James Serra data architecture', 'candidate')`),
    d1.prepare(`UPDATE tasks SET title = 'Bootstrap the HR Manager',
      brief = 'Build the Codex base image, start Aurelia, and verify that no other employee has the Docker socket.',
      status = 'done', assignee_id = 'employee-hrm', handoff_required = 0 WHERE id = 'task-runtime'`),
    d1.prepare(`UPDATE tasks SET title = 'Initialize the company control room',
      brief = 'Record the CEO-created command surface as founding infrastructure.',
      assignee_id = NULL, handoff_required = 0 WHERE id = 'task-control-room'`),
    d1.prepare(`UPDATE tasks SET status = 'queued', assignee_id = 'employee-beatrice',
      project_id = 'project-laazienda', updated_at = CURRENT_TIMESTAMP
      WHERE id = 'task-auth' AND assignee_id = 'employee-dorothy'`),
    d1.prepare(`UPDATE tasks SET title = 'Continue improving the LaAzienda application',
      assignee_id = COALESCE(assignee_id, 'employee-beatrice'),
      project_id = COALESCE(project_id, 'project-laazienda'), updated_at = CURRENT_TIMESTAMP
      WHERE title = 'Continue improve this OneManCompany application'`),
    d1.prepare(`UPDATE employees SET status = CASE WHEN runtime_status = 'running' THEN 'idle' ELSE 'offline' END,
      current_task_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = 'employee-dorothy' AND current_task_id IS NOT NULL`),
    d1.prepare(`UPDATE employees SET status = 'idle', current_task_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = 'employee-hrm' AND current_task_id IS NULL AND status = 'working'`),
  ]);

  await d1.prepare(`UPDATE employees SET status = 'failed', updated_at = CURRENT_TIMESTAMP
    WHERE runtime_status = 'running'
      AND (SELECT status FROM agent_runs
        WHERE agent_runs.employee_id = employees.id
        ORDER BY created_at DESC, id DESC LIMIT 1) = 'failed'
      AND NOT EXISTS (SELECT 1 FROM agent_runs active
        WHERE active.employee_id = employees.id AND active.status IN ('claimed', 'running'))`).run();

  await d1.batch(
    seedMappings.map(([status, animation, speed]) =>
      d1.prepare(`INSERT INTO animation_mappings (employee_status, animation_state, speed_ms)
        VALUES (?, ?, ?) ON CONFLICT(employee_status) DO NOTHING`).bind(status, animation, speed),
    ),
  );

  await d1.prepare("PRAGMA optimize").run();
}

export function ensureDatabase() {
  initialization ??= initialize().catch((error) => {
    initialization = undefined;
    throw error;
  });
  return initialization;
}
