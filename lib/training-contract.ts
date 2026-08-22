export const safeTrainingIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export const safeSkillFolderPattern = /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,78}[A-Za-z0-9])?$/i;
export const sha256Pattern = /^[0-9a-f]{64}$/;

const packageSegment = "[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,78}[A-Za-z0-9])?";
export const packageRefPattern = new RegExp(
  `^(${packageSegment})/(${packageSegment})(?:@(${packageSegment}))?$`,
);
export const npxSkillCommandPattern = new RegExp(
  `^npx(?:\\s+--yes)?\\s+skills\\s+add\\s+(${packageSegment}/${packageSegment}(?:@${packageSegment})?)(?:\\s+(?:-y|-g)){0,2}$`,
  "i",
);

export function canonicalSkillFolder(value: string): string | null {
  return safeSkillFolderPattern.test(value) ? value.toLowerCase() : null;
}

export function skillFolderFromPackageRef(packageRef: string): string | null {
  const match = packageRefPattern.exec(packageRef);
  if (!match) return null;
  const folder = match[3] || match[2];
  return canonicalSkillFolder(folder);
}

export function normalizeSkillPackageInput(value: string): string | null {
  const packageRef = npxSkillCommandPattern.exec(value)?.[1] ?? value;
  return packageRefPattern.test(packageRef) && skillFolderFromPackageRef(packageRef) ? packageRef : null;
}

export type EmployeeSkillFolderInput = {
  employeeId: string;
  skillId: string;
  folderKey: string | null;
  packageRef: string;
};

/**
 * Makes legacy desired-state rows safe for the employee/folder uniqueness
 * invariant. One deterministic row keeps a valid canonical folder; later
 * collisions receive portable reservations that cannot alias another row.
 */
export function resolveEmployeeSkillFolderReservations<T extends EmployeeSkillFolderInput>(rows: T[]): Array<T & { folderKey: string }> {
  const sorted = [...rows].sort((left, right) => {
    if (left.employeeId !== right.employeeId) return left.employeeId < right.employeeId ? -1 : 1;
    if (left.skillId === right.skillId) return 0;
    return left.skillId < right.skillId ? -1 : 1;
  });
  const result: Array<T & { folderKey: string }> = [];

  for (let index = 0; index < sorted.length;) {
    const employeeId = sorted[index].employeeId;
    const employeeRows: T[] = [];
    while (index < sorted.length && sorted[index].employeeId === employeeId) {
      employeeRows.push(sorted[index]);
      index += 1;
    }

    const candidates = employeeRows.map((row) => (
      row.folderKey && canonicalSkillFolder(row.folderKey)
        ? canonicalSkillFolder(row.folderKey)
        : skillFolderFromPackageRef(row.packageRef)
    ));
    const canonicalFolders = new Set(candidates.filter((candidate): candidate is string => candidate !== null));
    const used = new Set<string>();

    employeeRows.forEach((row, employeeIndex) => {
      const candidate = candidates[employeeIndex];
      let folderKey = candidate && !used.has(candidate) ? candidate : null;
      if (!folderKey) {
        let attempt = 1;
        do {
          folderKey = `legacy-reservation-${employeeIndex + 1}-${attempt}`;
          attempt += 1;
        } while (canonicalFolders.has(folderKey) || used.has(folderKey));
      }
      used.add(folderKey);
      result.push({ ...row, folderKey });
    });
  }

  return result;
}
