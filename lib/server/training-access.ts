export interface TrainingReadPrincipals {
  owner: boolean;
  bridge: boolean;
}

export const lockedTrainingEnvelope = Object.freeze({
  locked: true as const,
  error: "Training Center records are locked. Unlock CEO controls to continue.",
});

export function trainingReadAuthorized(principals: TrainingReadPrincipals) {
  return principals.owner || principals.bridge;
}
