# Reference research: 1mancompany/OneManCompany

Research refreshed on 2026-08-15 from the public [`1mancompany/OneManCompany`](https://github.com/1mancompany/OneManCompany) repository. This is an architectural comparison, not copied application code.

## Their onboarding model

The reference implementation separates an employee's **Talent** from its **Vessel**:

- Talent contains skills, knowledge, personality, tools, and a preferred model/execution mode.
- Vessel is the execution harness: lifecycle, retries, timeouts, tool access, communication, context, and storage contracts.
- HR searches the Talent Market; the CEO confirms the hire; onboarding creates the employee directory, installs the talent package, configures the vessel and permissions, assigns reporting structure, and makes the employee visible in the office.
- The Executive Assistant receives and routes requests. The COO decomposes approved objectives and dispatches specialists. Specialists execute within their domains.

The implementation supports company-hosted agents, self-hosted CLI agents, OpenClaw, and a remote HTTP protocol. The current `company` mode uses a LangChain agent through OpenRouter; `self` invokes Claude Code CLI; `openclaw` invokes an OpenClaw subprocess. Its vessel design defines separate execution, task, event, storage, context, and lifecycle protocols.

Primary reference paths:

- [onboarding implementation](https://github.com/1mancompany/OneManCompany/blob/main/src/onemancompany/agents/onboarding.py)
- [talent specification and hosting modes](https://github.com/1mancompany/OneManCompany/blob/main/src/onemancompany/talent_market/talent_spec.py)
- [vessel system](https://github.com/1mancompany/OneManCompany/blob/main/docs/vessel-system.md)
- [hiring guide](https://github.com/1mancompany/OneManCompany/blob/main/mkdocs-docs/guide/hiring.md)
- [execution modes](https://github.com/1mancompany/OneManCompany/blob/main/mkdocs-docs/guide/execution-modes.md)

## Founding employee LLM and harness snapshot

| Employee | Responsibility | Current company-hosted harness | Current profile model | Profile skills |
|---|---|---|---|---|
| Human Resources | Hiring and people operations | LangChain through OpenRouter | `google/gemini-3.1-pro-preview` | hiring, reviews, people management |
| Chief Operating Officer | Decomposition and operations | LangChain through OpenRouter | `google/gemini-3.1-pro-preview-customtools` | operations, tool management, strategy |
| Executive Assistant | Intake, analysis, and routing | LangChain through OpenRouter | `google/gemini-3.1-pro-preview` | task analysis, task routing, project management |
| Chief Sales Officer | Sales and clients | LangChain through OpenRouter | `openai/gpt-5.2` | sales management, contract review, client relations |

Each founding profile also declares the reference project's alternative Claude Code and OpenClaw vessels. See its employee profile files for [HR](https://github.com/1mancompany/OneManCompany/blob/main/company/human_resource/employees/00002/profile.yaml), [COO](https://github.com/1mancompany/OneManCompany/blob/main/company/operations/employees/00003/profile.yaml), [Executive Assistant](https://github.com/1mancompany/OneManCompany/blob/main/company/executive_office/employees/00004/profile.yaml), and [CSO](https://github.com/1mancompany/OneManCompany/blob/main/company/sales/employees/00005/profile.yaml). These are repository defaults and can change upstream.

## What this application adopts

- A read-only secretary gives the CEO a company-wide evidence view; Project Managers own project context and delegation while HR owns runtime provisioning.
- Role, prompt, training, runtime, communication, and company records remain separate contracts.
- Onboarding starts from a reusable role profile, then snapshots an employee-specific brain and installed skills.
- Every employee gets an isolated vessel with explicit capabilities and a real communication address.
- Projects, quality gates, task ownership, contractor handoffs, and reusable knowledge are durable records rather than chat convention.

## What stays distinctly ours

- Every employee brain and harness is Codex CLI, launched non-interactively with `codex exec`; roles vary prompts, skills, and permissions rather than provider identity.
- D1 is the company record, the Training Center is the reviewed skill cache, Stalwart is internal communication, and one Docker container is the employee runtime boundary. Aurelia is the sole socket holder.
- Dorothy is explicitly read-only; the visual identity remains the original 8-bit Codex Pets office with role-specific character policy.
- No scripted transcript or simulated status is presented as agent execution, delivery, or completion.
- Permanent Experts retain their workspace; Contractors use Solaire, generated Medieval names, task-scoped authority, and a mandatory knowledge-return handoff.

## Feature gap kept as an honest backlog

The reference repository also models meetings, autonomous-control levels, coaching, reviews and performance-improvement plans, employee/talent versioning, multi-stage quality gates, retrospectives, SOP promotion, file approvals, cost accounting, and reporting hierarchy. Those ideas are useful, but they should be added only when backed by real records and executor evidence. The current next slice is approved `codex exec` dispatch and repository provisioning, followed by correlated artifacts and progress events.

## Official Microsoft Expert sources

The Microsoft Expert curriculum is seeded from Microsoft-owned repositories rather than lookalike packages:

- [`microsoft/skills`](https://github.com/microsoft/skills): the currently published `copilot-sdk` skill.
- [`microsoft/agent365-skills`](https://github.com/microsoft/agent365-skills): `a365-setup` and related Agent 365 workflows.
- [`MicrosoftDocs/Agent-Skills`](https://github.com/MicrosoftDocs/Agent-Skills): the Microsoft Learn-backed `azure-well-architected` skill and a larger curated Azure catalog.

Each source still passes through the local Training Center review. A seeded request does not claim a skill is installed until its real `SKILL.md` exists in the cache and the master confirms it.
