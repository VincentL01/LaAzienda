export type ControlScope = "company" | "mail";
export type ControlPrincipal = "owner" | "bridge";

const companyOwnerActions = new Set([
  "createTask",
  "assignTask",
  "askSecretary",
  "createProject",
  "approveProject",
  "submitHandoff",
  "retryTask",
  "advanceTask",
  "setEmployeeStatus",
  "saveMappings",
]);

const companyBridgeActions = new Set([
  "reportProjectRepository",
  "retryAuthenticationBlocked",
  "retryGithubAuthenticationBlocked",
  "reportRepositorySync",
]);

const mailOwnerActions = new Set(["queueMail"]);
const mailBridgeActions = new Set(["reportDelivery", "reportMailbox"]);

export function requiredControlPrincipal(scope: ControlScope, action: unknown): ControlPrincipal | null {
  if (typeof action !== "string") return null;
  const ownerActions = scope === "company" ? companyOwnerActions : mailOwnerActions;
  const bridgeActions = scope === "company" ? companyBridgeActions : mailBridgeActions;
  if (ownerActions.has(action)) return "owner";
  if (bridgeActions.has(action)) return "bridge";
  return null;
}

export function controlActionAuthorized(
  scope: ControlScope,
  action: unknown,
  access: { owner: boolean; bridge: boolean },
) {
  const required = requiredControlPrincipal(scope, action);
  return required !== null && access[required];
}
