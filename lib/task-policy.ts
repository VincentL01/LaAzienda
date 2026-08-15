export interface ActiveTaskIdentity {
  id: string;
  title: string;
}

export function findActiveTaskConflict<T extends ActiveTaskIdentity>(
  activeTasks: readonly T[],
  requestedTaskId: string,
): T | undefined {
  return activeTasks.find((task) => task.id !== requestedTaskId);
}
