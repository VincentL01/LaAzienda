const DISCORD_STATUS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const OWNER_SESSION_VERIFIER_PATTERN = /^[a-f0-9]{64}$/;

export function buildLocalBindingVars(environment: Record<string, string | undefined> = {}) {
  const runtimeBridgeToken = environment.RUNTIME_BRIDGE_TOKEN;
  const sourceCommit = environment.SOURCE_COMMIT;
  const ownerCandidate = environment.OWNER_SESSION_VERIFIER?.trim();
  const ownerSessionVerifier = ownerCandidate && OWNER_SESSION_VERIFIER_PATTERN.test(ownerCandidate)
    ? ownerCandidate
    : undefined;
  const discordCandidate = environment.DISCORD_STATUS_TOKEN?.trim();
  const discordStatusToken = discordCandidate && DISCORD_STATUS_TOKEN_PATTERN.test(discordCandidate)
    ? discordCandidate
    : undefined;

  return {
    ...(runtimeBridgeToken ? { RUNTIME_BRIDGE_TOKEN: runtimeBridgeToken } : {}),
    ...(ownerSessionVerifier ? { OWNER_SESSION_VERIFIER: ownerSessionVerifier } : {}),
    ...(sourceCommit ? { SOURCE_COMMIT: sourceCommit } : {}),
    ...(discordStatusToken ? { DISCORD_STATUS_TOKEN: discordStatusToken } : {}),
  };
}
