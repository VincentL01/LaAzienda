import { statusLabels, type AnimationMapping, type CompanyTask, type Employee, type EmployeeStatus } from "@/lib/company";
import { EmployeeSprite } from "./EmployeeSprite";

const officeZones: Array<{
  id: string;
  name: string;
  detail: string;
  statuses: EmployeeStatus[];
}> = [
  { id: "main-office", name: "Main office", detail: "Active delivery", statuses: ["working"] },
  { id: "planning-room", name: "Planning room", detail: "Briefs and setup", statuses: ["planning", "starting"] },
  { id: "review-lab", name: "Review lab", detail: "Evidence and approval", statuses: ["review"] },
  { id: "support-bay", name: "Support bay", detail: "Blocked or waiting", statuses: ["waiting", "failed"] },
  { id: "pantry", name: "Pantry", detail: "Available and resting", statuses: ["idle", "done"] },
  { id: "lobby", name: "Lobby", detail: "Offline employees", statuses: ["offline"] },
];

export function officeZoneForStatus(status: EmployeeStatus) {
  return officeZones.find((zone) => zone.statuses.includes(status)) ?? officeZones[4];
}

interface LiveOfficeProps {
  employees: Employee[];
  tasks: CompanyTask[];
  mappings: AnimationMapping[];
  selectedEmployeeId: string | null;
  onSelectEmployee: (employeeId: string) => void;
}

export function LiveOffice({ employees, tasks, mappings, selectedEmployeeId, onSelectEmployee }: LiveOfficeProps) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const mappingByStatus = new Map(mappings.map((mapping) => [mapping.employeeStatus, mapping]));

  return <div className="company-floor" aria-label="Live company office">
    {officeZones.map((zone) => {
      const occupants = employees.filter((employee) => zone.statuses.includes(employee.status));
      return <section className={`office-zone zone-${zone.id}`} key={zone.id} aria-label={zone.name}>
        <header><div><b>{zone.name}</b><span>{zone.detail}</span></div><em>{occupants.length}</em></header>
        <div className="zone-room">
          <div className="room-furniture" aria-hidden="true"><i /><i /><b /></div>
          <div className="zone-occupants">
            {occupants.map((employee) => {
              const task = employee.currentTaskId ? taskById.get(employee.currentTaskId) : undefined;
              const mapping = mappingByStatus.get(employee.status);
              return <button
                className={`office-employee ${selectedEmployeeId === employee.id ? "selected" : ""}`}
                key={employee.id}
                onClick={() => onSelectEmployee(employee.id)}
                aria-pressed={selectedEmployeeId === employee.id}
                aria-label={`Inspect ${employee.name}, ${statusLabels[employee.status]}`}
              >
                <span className="employee-work-label">{task?.title ?? statusLabels[employee.status]}</span>
                <EmployeeSprite
                  animation={mapping?.animationState ?? "idle"}
                  speedMs={mapping?.speedMs}
                  size="small"
                  spritesheetPath={employee.spritesheetPath}
                  label={`${employee.name} in ${zone.name}`}
                />
                <span className="floor-name"><b>{employee.name}</b><small><i className={`status-dot status-${employee.status}`} />{statusLabels[employee.status]}</small></span>
              </button>;
            })}
            {occupants.length === 0 ? <span className="empty-zone">Room available</span> : null}
          </div>
        </div>
      </section>;
    })}
  </div>;
}
