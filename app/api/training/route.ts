import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";
import type { TrainingAssignment, TrainingCenterState, TrainingSyncEvent } from "@/lib/company";
import { bridgeAuthorized } from "@/lib/server/bridge-auth";
import { readBoundedJsonObject } from "@/lib/server/bounded-json";
import { ownerAuthorized } from "@/lib/server/owner-auth";
import { lockedTrainingEnvelope, trainingReadAuthorized } from "@/lib/server/training-access";
import { readWorkforce } from "@/lib/server/workforce";
import {
  canonicalSkillFolder,
  normalizeSkillPackageInput,
  safeTrainingIdPattern,
  sha256Pattern,
  skillFolderFromPackageRef,
} from "@/lib/training-contract";

const petSlugPattern = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function sameNullable(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

async function readTraining(request: Request): Promise<TrainingCenterState> {
  const workforce = await readWorkforce();
  const d1 = env.DB;
  const [assignmentResult, historyResult, generationRow] = await Promise.all([
    d1.prepare(`SELECT es.employee_id AS employeeId, e.name AS employeeName,
      es.skill_id AS skillId, s.name AS skillName, s.package_ref AS packageRef,
      es.folder_key AS folderKey,
      es.assigned_at AS assignedAt, es.updated_at AS desiredUpdatedAt,
      CASE es.desired_state WHEN 'revoked' THEN 'remove' ELSE 'install' END AS desiredOperation,
      es.assignment_version AS assignmentVersion,
      o.status AS syncStatus, o.manifest_version AS manifestVersion,
      o.source_hash AS sourceHash, o.staged_hash AS stagedHash, o.verified_hash AS verifiedHash,
      o.attempt AS attempts, o.evidence,
      CASE WHEN o.status = 'verified' THEN o.observed_at ELSE NULL END AS verifiedAt,
      o.observed_at AS lastAttemptAt
      FROM employee_skills es
      JOIN employees e ON e.id = es.employee_id
      JOIN training_center_skills s ON s.id = es.skill_id
      LEFT JOIN training_sync_observations o ON o.id = (
        SELECT MAX(o2.id) FROM training_sync_observations o2
        WHERE o2.employee_id = es.employee_id AND o2.skill_id = es.skill_id
          AND o2.operation = CASE es.desired_state WHEN 'revoked' THEN 'remove' ELSE 'install' END
          AND o2.assignment_version = es.assignment_version
      )
      ORDER BY es.updated_at DESC, e.name, s.name`).all(),
    d1.prepare(`SELECT o.id, h.event_key AS eventKey, o.employee_id AS employeeId,
      e.name AS employeeName, o.skill_id AS skillId, s.name AS skillName,
      o.operation, o.assignment_version AS assignmentVersion, o.status,
      o.manifest_version AS manifestVersion, o.source_hash AS sourceHash,
      o.staged_hash AS stagedHash, o.verified_hash AS verifiedHash,
      o.evidence, o.worker_id AS workerId, o.attempt AS attempts,
      CASE WHEN o.status = 'verified' THEN o.observed_at ELSE NULL END AS verifiedAt,
      h.created_at AS createdAt, o.observed_at AS updatedAt
      FROM training_sync_observations o
      JOIN training_sync_history h ON h.id = o.history_id
      JOIN employees e ON e.id = o.employee_id
      JOIN training_center_skills s ON s.id = o.skill_id
      ORDER BY o.id DESC LIMIT 100`).all(),
    d1.prepare(`SELECT generation FROM control_generations WHERE control_key = 'training'`)
      .first<{ generation: number }>(),
  ]);
  const history = historyResult.results as unknown as TrainingSyncEvent[];
  const assignments = assignmentResult.results.map((row) => {
    const assignment = row as unknown as Pick<TrainingAssignment,
      "employeeId" | "employeeName" | "skillId" | "skillName" | "packageRef" | "folderKey" | "assignedAt" |
      "desiredUpdatedAt" | "desiredOperation" | "assignmentVersion" | "manifestVersion" |
      "sourceHash" | "stagedHash" | "verifiedHash" | "attempts" | "evidence" |
      "verifiedAt" | "lastAttemptAt"> & { syncStatus: TrainingAssignment["status"] | null };
    const { syncStatus, ...fields } = assignment;
    return {
      ...fields,
      status: syncStatus ?? "pending",
      manifestVersion: assignment.manifestVersion ?? null,
      sourceHash: assignment.sourceHash ?? null,
      stagedHash: assignment.stagedHash ?? null,
      verifiedHash: assignment.verifiedHash ?? null,
      attempts: assignment.attempts ?? 0,
      evidence: assignment.evidence || "Waiting for Aurelia to reconcile this desired training version.",
      verifiedAt: assignment.verifiedAt ?? null,
      lastAttemptAt: assignment.lastAttemptAt ?? null,
    } satisfies TrainingAssignment;
  });
  return {
    skills: workforce.skills,
    characters: workforce.characters,
    employees: workforce.employees
      .filter((employee) => !employee.dockerSocketAccess)
      .map(({ id, name, role, department }) => ({ id, name, role, department })),
    assignments,
    history,
    discoveryCommand: "npx skills find <query>",
    petCatalogUrl: "https://codex-pets.net/",
    ownerAuthorized: await ownerAuthorized(request),
    desiredGeneration: generationRow?.generation ?? 1,
  };
}

export async function GET(request: Request) {
  try {
    const bridgeIsAuthorized = bridgeAuthorized(request);
    const ownerIsAuthorized = await ownerAuthorized(request);
    if (!trainingReadAuthorized({ bridge: bridgeIsAuthorized, owner: ownerIsAuthorized })) {
      return Response.json(lockedTrainingEnvelope, { status: 403 });
    }
    await ensureDatabase();
    return Response.json(await readTraining(request));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Training Center unavailable" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let replayPackageRef: string | null = null;
  try {
    const bridgeIsAuthorized = bridgeAuthorized(request);
    const ownerIsAuthorized = await ownerAuthorized(request);
    if (!bridgeIsAuthorized && !ownerIsAuthorized) {
      return Response.json({ error: "Training authorization is required" }, { status: 403 });
    }
    const parsed = await readBoundedJsonObject(request, 32 * 1024);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
    await ensureDatabase();
    const body = parsed.value;
    const action = cleanText(body.action, 50);
    const d1 = env.DB;

    if (action === "reportSkillSync") {
      if (!bridgeIsAuthorized) return Response.json({ error: "Training bridge authorization failed" }, { status: 403 });
      const employeeId = cleanText(body.employeeId, 100);
      const skillId = cleanText(body.skillId, 100);
      const workerId = cleanText(body.workerId, 100);
      const status = cleanText(body.status, 20) as "verified" | "failed";
      const operation = cleanText(body.operation, 20) as "install" | "remove";
      const assignmentVersion = Number(body.assignmentVersion);
      const manifestVersion = cleanText(body.manifestVersion, 64) || null;
      const sourceHash = cleanText(body.sourceHash, 64) || null;
      const stagedHash = cleanText(body.stagedHash, 64) || null;
      const verifiedHash = cleanText(body.verifiedHash, 64) || null;
      const evidence = cleanText(body.evidence, 600);
      if (![employeeId, skillId, workerId].every((value) => safeTrainingIdPattern.test(value))) {
        return Response.json({ error: "Training sync identity is invalid" }, { status: 400 });
      }
      if (!(["verified", "failed"] as const).includes(status)) return Response.json({ error: "Training sync status is invalid" }, { status: 400 });
      if (!(["install", "remove"] as const).includes(operation) || !Number.isInteger(assignmentVersion) || assignmentVersion < 1) {
        return Response.json({ error: "Training sync operation is invalid" }, { status: 400 });
      }
      if (!manifestVersion || !sha256Pattern.test(manifestVersion)) return Response.json({ error: "Manifest version is invalid" }, { status: 400 });
      if ([sourceHash, stagedHash, verifiedHash].some((hash) => hash && !sha256Pattern.test(hash))) {
        return Response.json({ error: "Training sync hashes are invalid" }, { status: 400 });
      }
      if (status === "verified" && operation === "install" && (!sourceHash || sourceHash !== stagedHash || sourceHash !== verifiedHash)) {
        return Response.json({ error: "Verified installation requires matching cache, staged-volume, and independent workspace hashes" }, { status: 400 });
      }
      if (status === "verified" && operation === "remove" && (sourceHash || stagedHash || verifiedHash)) {
        return Response.json({ error: "Verified removal must report path absence rather than a content hash" }, { status: 400 });
      }

      const assignment = await d1.prepare(`SELECT e.name AS employeeName, s.name AS skillName,
        es.desired_state AS desiredState, es.assignment_version AS assignmentVersion,
        s.approved_digest AS approvedDigest, s.observed_digest AS observedDigest
        FROM employee_skills es JOIN employees e ON e.id = es.employee_id
        JOIN training_center_skills s ON s.id = es.skill_id
        WHERE es.employee_id = ? AND es.skill_id = ?`).bind(employeeId, skillId)
        .first<{ employeeName: string; skillName: string; desiredState: string; assignmentVersion: number; approvedDigest: string | null; observedDigest: string | null }>();
      if (!assignment) return Response.json({ error: "The desired employee skill assignment no longer exists" }, { status: 409 });
      const desiredOperation = assignment.desiredState === "revoked" ? "remove" : "install";
      if (desiredOperation !== operation || assignment.assignmentVersion !== assignmentVersion) {
        return Response.json({ error: "The training assignment changed before this evidence was reported" }, { status: 409 });
      }
      if (status === "verified" && operation === "install" &&
          (!assignment.approvedDigest || assignment.approvedDigest !== assignment.observedDigest || assignment.approvedDigest !== sourceHash)) {
        return Response.json({ error: "The cache digest is not the currently approved training revision" }, { status: 409 });
      }

      const latest = await d1.prepare(`SELECT id, status, manifest_version AS manifestVersion,
        source_hash AS sourceHash, staged_hash AS stagedHash, verified_hash AS verifiedHash, evidence
        FROM training_sync_observations WHERE employee_id = ? AND skill_id = ?
          AND operation = ? AND assignment_version = ? ORDER BY id DESC LIMIT 1`)
        .bind(employeeId, skillId, operation, assignmentVersion)
        .first<{ id: number; status: string; manifestVersion: string | null; sourceHash: string | null; stagedHash: string | null; verifiedHash: string | null; evidence: string }>();
      if (latest && latest.status === status && latest.manifestVersion === manifestVersion &&
          sameNullable(latest.sourceHash, sourceHash) && sameNullable(latest.stagedHash, stagedHash) &&
          sameNullable(latest.verifiedHash, verifiedHash) && latest.evidence === evidence) {
        return Response.json(await readTraining(request));
      }

      const previousObservationId = latest?.id ?? 0;
      const contentVersion = operation === "install" ? sourceHash ?? "source-unavailable" : "path-absent";
      const eventKey = `training:${employeeId}:${skillId}:${operation}:v${assignmentVersion}:m${manifestVersion}:${contentVersion}`;
      const activityMessage = status === "verified"
        ? operation === "install"
          ? `${assignment.employeeName} completed ${assignment.skillName} training with three-way hash verification.`
          : `${assignment.employeeName}'s ${assignment.skillName} training was removed with verified workspace evidence.`
        : `${assignment.employeeName}'s ${assignment.skillName} training ${operation} failed verification.`;
      const syncResults = await d1.batch([
        d1.prepare(`INSERT OR IGNORE INTO training_sync_history (
          event_key, employee_id, skill_id, operation, assignment_version, status, manifest_version,
          source_hash, staged_hash, verified_hash, evidence, worker_id, attempts, verified_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
          CASE WHEN ? = 'verified' THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)`)
          .bind(eventKey, employeeId, skillId, operation, assignmentVersion, status, manifestVersion,
            sourceHash, stagedHash, verifiedHash, evidence, workerId, status),
        d1.prepare(`INSERT OR IGNORE INTO training_sync_observations (
          history_id, previous_observation_id, employee_id, skill_id, operation, assignment_version,
          status, manifest_version, source_hash, staged_hash, verified_hash, evidence, worker_id, attempt
        ) SELECT h.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          1 + (SELECT COUNT(*) FROM training_sync_observations prior WHERE prior.history_id = h.id)
          FROM training_sync_history h JOIN employee_skills es
            ON es.employee_id = ? AND es.skill_id = ?
          WHERE h.event_key = ?
            AND es.desired_state = ? AND es.assignment_version = ?
            AND ? = COALESCE((SELECT MAX(current.id) FROM training_sync_observations current
              WHERE current.employee_id = ? AND current.skill_id = ?
                AND current.operation = ? AND current.assignment_version = ?), 0)
            AND (? != 'verified' OR ? != 'install' OR EXISTS (
              SELECT 1 FROM training_center_skills current_skill
              WHERE current_skill.id = es.skill_id
                AND current_skill.approved_digest = current_skill.observed_digest
                AND current_skill.approved_digest = ?
            ))`)
          .bind(previousObservationId, employeeId, skillId, operation, assignmentVersion,
            status, manifestVersion, sourceHash, stagedHash, verifiedHash, evidence, workerId,
            employeeId, skillId, eventKey, operation === "remove" ? "revoked" : "assigned", assignmentVersion,
            previousObservationId, employeeId, skillId, operation, assignmentVersion,
            status, operation, sourceHash),
        d1.prepare("INSERT INTO activity (message, tone) SELECT ?, ? WHERE changes() > 0")
          .bind(activityMessage, status === "verified" ? "success" : "failed"),
        d1.prepare(`UPDATE training_sync_history SET status = ?, manifest_version = ?, source_hash = ?,
          staged_hash = ?, verified_hash = ?, evidence = ?, worker_id = ?,
          attempts = (SELECT MAX(o.attempt) FROM training_sync_observations o WHERE o.history_id = training_sync_history.id),
          verified_at = CASE WHEN ? = 'verified' THEN CURRENT_TIMESTAMP ELSE verified_at END,
          updated_at = CURRENT_TIMESTAMP
          WHERE event_key = ? AND EXISTS (
            SELECT 1 FROM training_sync_observations o WHERE o.history_id = training_sync_history.id
              AND o.previous_observation_id = ? AND o.status = ? AND o.manifest_version = ?)`)
          .bind(status, manifestVersion, sourceHash, stagedHash, verifiedHash, evidence, workerId,
            status, eventKey, previousObservationId, status, manifestVersion),
        d1.prepare(`DELETE FROM employee_skills WHERE employee_id = ? AND skill_id = ?
          AND desired_state = 'revoked' AND assignment_version = ? AND ? = 'verified' AND ? = 'remove'
          AND EXISTS (SELECT 1 FROM training_sync_observations o
            WHERE o.employee_id = employee_skills.employee_id AND o.skill_id = employee_skills.skill_id
              AND o.operation = 'remove' AND o.assignment_version = employee_skills.assignment_version
              AND o.previous_observation_id = ? AND o.status = 'verified' AND o.manifest_version = ?)`)
          .bind(employeeId, skillId, assignmentVersion, status, operation, previousObservationId, manifestVersion),
        d1.prepare(`UPDATE control_generations SET generation = generation + 1,
          updated_at = CURRENT_TIMESTAMP WHERE control_key = 'training' AND changes() > 0`),
      ]);
      if (Number(syncResults[1]?.meta?.changes ?? 0) === 0) {
        const current = await d1.prepare(`SELECT es.desired_state AS desiredState,
          es.assignment_version AS assignmentVersion, s.approved_digest AS approvedDigest,
          s.observed_digest AS observedDigest FROM employee_skills es
          JOIN training_center_skills s ON s.id = es.skill_id
          WHERE es.employee_id = ? AND es.skill_id = ?`).bind(employeeId, skillId)
          .first<{ desiredState: string; assignmentVersion: number; approvedDigest: string | null; observedDigest: string | null }>();
        if (!current || current.desiredState !== (operation === "remove" ? "revoked" : "assigned") ||
            current.assignmentVersion !== assignmentVersion ||
            (status === "verified" && operation === "install" &&
              (!current.approvedDigest || current.approvedDigest !== current.observedDigest || current.approvedDigest !== sourceHash))) {
          return Response.json({ error: "Training evidence became stale before it could be recorded" }, { status: 409 });
        }
      }
    } else if (action === "reportCacheObservation") {
      if (!bridgeIsAuthorized) return Response.json({ error: "Training bridge authorization failed" }, { status: 403 });
      const skillId = cleanText(body.skillId, 100);
      const submittedFolderKey = cleanText(body.folderKey, 80);
      const folderKey = canonicalSkillFolder(submittedFolderKey);
      const observedDigest = cleanText(body.observedDigest, 64) || null;
      const observationStatus = cleanText(body.observationStatus, 20);
      const observationEvidence = cleanText(body.evidence, 400) || (observationStatus === "missing"
        ? "The expected Training Center folder or SKILL.md is missing on the host."
        : observationStatus === "failed" ? "Aurelia could not safely hash the Training Center folder." : "Host cache hash observed.");
      if (!safeTrainingIdPattern.test(skillId) || !folderKey ||
          !["observed", "missing", "failed"].includes(observationStatus) ||
          (observationStatus === "observed" && (!observedDigest || !sha256Pattern.test(observedDigest))) ||
          (observationStatus !== "observed" && observedDigest !== null)) {
        return Response.json({ error: "Cache observation is invalid" }, { status: 400 });
      }
      const skill = await d1.prepare(`SELECT name, package_ref AS packageRef
        FROM training_center_skills WHERE id = ?`).bind(skillId)
        .first<{ name: string; packageRef: string }>();
      if (!skill || skillFolderFromPackageRef(skill.packageRef) !== folderKey) {
        return Response.json({ error: "Cache observation does not match the catalog folder" }, { status: 409 });
      }
      await d1.batch([
        d1.prepare(`UPDATE training_center_skills SET folder_key = ?, observed_digest = ?,
          observed_at = CURRENT_TIMESTAMP, observation_status = ?, observation_evidence = ?,
          cache_status = CASE
            WHEN ? != 'observed' THEN 'failed'
            WHEN approved_digest = ? THEN 'cached'
            WHEN approved_digest IS NOT NULL THEN 'drifted'
            ELSE 'observed' END,
          updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND (COALESCE(folder_key, '') COLLATE NOCASE != ? OR
            COALESCE(observed_digest, '') != COALESCE(?, '') OR cache_status != CASE
              WHEN ? != 'observed' THEN 'failed'
              WHEN approved_digest = ? THEN 'cached'
              WHEN approved_digest IS NOT NULL THEN 'drifted'
              ELSE 'observed' END OR
            COALESCE(observation_status, '') != ? OR COALESCE(observation_evidence, '') != ?)`)
          .bind(folderKey, observedDigest, observationStatus, observationEvidence,
            observationStatus, observedDigest, skillId, folderKey, observedDigest,
            observationStatus, observedDigest, observationStatus, observationEvidence),
        d1.prepare(`UPDATE control_generations SET generation = generation + 1,
          updated_at = CURRENT_TIMESTAMP WHERE control_key = 'training' AND changes() > 0`),
        d1.prepare(`INSERT INTO activity (message, tone)
          SELECT CASE WHEN observation_status = 'observed'
            THEN 'Aurelia observed ' || ? || ' cache revision ' || substr(observed_digest, 1, 12) ||
              '…; CEO approval status is ' || cache_status || '.'
            ELSE 'Aurelia could not verify the ' || ? || ' Training Center cache.' END,
            CASE cache_status WHEN 'cached' THEN 'success' WHEN 'failed' THEN 'failed' ELSE 'neutral' END
          FROM training_center_skills WHERE id = ? AND changes() > 0`)
          .bind(skill.name, skill.name, skillId),
      ]);
    } else {
      if (!ownerIsAuthorized) {
        return Response.json({ error: "Unlock CEO training controls before changing desired training state" }, { status: 403 });
      }

      if (action === "assignSkill") {
        const employeeId = cleanText(body.employeeId, 100);
        const skillId = cleanText(body.skillId, 100);
        if (!safeTrainingIdPattern.test(employeeId) || !safeTrainingIdPattern.test(skillId)) {
          return Response.json({ error: "Choose a valid employee and skill" }, { status: 400 });
        }
        const [employee, skill] = await Promise.all([
          d1.prepare("SELECT name FROM employees WHERE id = ? AND docker_socket_access = 0")
            .bind(employeeId).first<{ name: string }>(),
          d1.prepare(`SELECT name, folder_key AS folderKey, approved_digest AS approvedDigest,
            observed_digest AS observedDigest FROM training_center_skills WHERE id = ?`)
            .bind(skillId).first<{ name: string; folderKey: string | null; approvedDigest: string | null; observedDigest: string | null }>(),
        ]);
        if (!employee) return Response.json({ error: "Choose an employee managed by Aurelia's training reconciler" }, { status: 404 });
        const folderKey = skill?.folderKey ? canonicalSkillFolder(skill.folderKey) : null;
        if (!skill || !folderKey ||
            !skill.approvedDigest || skill.approvedDigest !== skill.observedDigest) {
          return Response.json({ error: "Only the currently observed and CEO-approved cache revision can be assigned" }, { status: 400 });
        }
        const collision = await d1.prepare(`SELECT s.name FROM employee_skills es
          JOIN training_center_skills s ON s.id = es.skill_id
          WHERE es.employee_id = ? AND es.folder_key = ? COLLATE NOCASE AND es.skill_id != ?`)
          .bind(employeeId, folderKey, skillId).first<{ name: string }>();
        if (collision) return Response.json({ error: `${collision.name} still reserves the ${folderKey} workspace folder` }, { status: 409 });
        await d1.batch([
          d1.prepare(`INSERT INTO employee_skills (
              employee_id, skill_id, folder_key, desired_state, assignment_version, assigned_at, updated_at)
            SELECT ?, ?, ?, 'assigned',
              COALESCE((SELECT MAX(h.assignment_version) + 1 FROM training_sync_history h
                WHERE h.employee_id = ? AND h.skill_id = ?), 1),
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            ON CONFLICT(employee_id, skill_id) DO UPDATE SET folder_key = excluded.folder_key,
              desired_state = 'assigned', assignment_version = MAX(
                employee_skills.assignment_version + 1, excluded.assignment_version),
              assigned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE employee_skills.desired_state = 'revoked'`)
            .bind(employeeId, skillId, folderKey, employeeId, skillId),
          d1.prepare(`UPDATE control_generations SET generation = generation + 1,
            updated_at = CURRENT_TIMESTAMP WHERE control_key = 'training' AND changes() > 0`),
          d1.prepare("INSERT INTO activity (message, tone) SELECT ?, 'neutral' WHERE changes() > 0")
            .bind(`${employee.name} was assigned ${skill.name} training; versioned verification is pending.`),
        ]);
      } else if (action === "revokeSkill") {
        const employeeId = cleanText(body.employeeId, 100);
        const skillId = cleanText(body.skillId, 100);
        if (!safeTrainingIdPattern.test(employeeId) || !safeTrainingIdPattern.test(skillId)) {
          return Response.json({ error: "Choose a valid employee and skill" }, { status: 400 });
        }
        const assignment = await d1.prepare(`SELECT e.name AS employeeName, s.name AS skillName
          FROM employee_skills es JOIN employees e ON e.id = es.employee_id
          JOIN training_center_skills s ON s.id = es.skill_id
          WHERE es.employee_id = ? AND es.skill_id = ?`).bind(employeeId, skillId)
          .first<{ employeeName: string; skillName: string }>();
        if (!assignment) return Response.json({ error: "Training assignment not found" }, { status: 404 });
        await d1.batch([
          d1.prepare(`UPDATE employee_skills SET desired_state = 'revoked',
            assignment_version = assignment_version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE employee_id = ? AND skill_id = ? AND desired_state = 'assigned'`)
            .bind(employeeId, skillId),
          d1.prepare(`UPDATE control_generations SET generation = generation + 1,
            updated_at = CURRENT_TIMESTAMP WHERE control_key = 'training' AND changes() > 0`),
          d1.prepare("INSERT INTO activity (message, tone) SELECT ?, 'neutral' WHERE changes() > 0")
            .bind(`${assignment.employeeName}'s ${assignment.skillName} training was revoked; verified removal is pending.`),
        ]);
      } else if (action === "requestSkill") {
        const submitted = cleanText(body.packageRef, 260);
        const packageRef = normalizeSkillPackageInput(submitted);
        if (!packageRef) return Response.json({ error: "Use owner/repository@skill-name with conservative folder names" }, { status: 400 });
        replayPackageRef = packageRef;
        const folderKey = skillFolderFromPackageRef(packageRef);
        if (!folderKey) return Response.json({ error: "The package would create an unsafe workspace folder" }, { status: 400 });
        const name = cleanText(body.name, 80) || folderKey;
        const description = cleanText(body.description, 400);
        const sourceUrl = cleanText(body.sourceUrl, 500) || null;
        const id = `skill-${crypto.randomUUID()}`;
        await d1.batch([
          d1.prepare(`INSERT INTO training_center_skills (
            id, package_ref, name, description, source_url, install_command, folder_key, cache_status, updated_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, 'requested', CURRENT_TIMESTAMP
            WHERE NOT EXISTS (SELECT 1 FROM training_center_skills WHERE package_ref = ?)`)
            .bind(id, packageRef, name, description, sourceUrl, `npx skills add ${packageRef} -y`, folderKey, packageRef),
          d1.prepare("INSERT INTO activity (message, tone) SELECT ?, 'neutral' WHERE changes() > 0")
            .bind(`Training Center queued ${name} for import and independent cache observation.`),
        ]);
      } else if (action === "approveSkillCache" || action === "confirmSkillCached") {
        const skillId = cleanText(body.skillId, 100);
        const expectedObservedDigest = cleanText(body.expectedObservedDigest, 64);
        if (!sha256Pattern.test(expectedObservedDigest)) {
          return Response.json({ error: "Refresh the Training Room and approve the exact observed digest shown" }, { status: 400 });
        }
        const skill = await d1.prepare(`SELECT name, observed_digest AS observedDigest,
          approved_digest AS approvedDigest FROM training_center_skills WHERE id = ?`)
          .bind(skillId).first<{ name: string; observedDigest: string | null; approvedDigest: string | null }>();
        if (!skill) return Response.json({ error: "Skill request not found" }, { status: 404 });
        if (!skill.observedDigest || !sha256Pattern.test(skill.observedDigest)) {
          return Response.json({ error: "Aurelia must independently observe a valid cache digest before CEO approval" }, { status: 409 });
        }
        if (skill.observedDigest !== expectedObservedDigest) {
          return Response.json({ error: "The observed cache revision changed; refresh before approving it" }, { status: 409 });
        }
        const approvalResults = await d1.batch([
          d1.prepare(`UPDATE employee_skills SET assignment_version = assignment_version + 1,
            updated_at = CURRENT_TIMESTAMP WHERE skill_id = ? AND desired_state = 'assigned'
            AND EXISTS (SELECT 1 FROM training_center_skills s WHERE s.id = employee_skills.skill_id
              AND s.observed_digest = ? AND COALESCE(s.approved_digest, '') != s.observed_digest)`)
            .bind(skillId, expectedObservedDigest),
          d1.prepare(`UPDATE training_center_skills SET approved_digest = observed_digest,
            approval_version = approval_version + 1, approved_at = CURRENT_TIMESTAMP,
            cached_at = CURRENT_TIMESTAMP, cache_status = 'cached', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND observed_digest = ?
              AND COALESCE(approved_digest, '') != observed_digest`).bind(skillId, expectedObservedDigest),
          d1.prepare(`UPDATE control_generations SET generation = generation + 1,
            updated_at = CURRENT_TIMESTAMP WHERE control_key = 'training' AND changes() > 0`),
          d1.prepare("INSERT INTO activity (message, tone) SELECT ?, 'success' WHERE changes() > 0")
            .bind(`${skill.name} cache revision ${expectedObservedDigest.slice(0, 12)}… was approved by the CEO.`),
        ]);
        if (Number(approvalResults[1]?.meta?.changes ?? 0) === 0) {
          const current = await d1.prepare("SELECT observed_digest AS observedDigest, approved_digest AS approvedDigest FROM training_center_skills WHERE id = ?")
            .bind(skillId).first<{ observedDigest: string | null; approvedDigest: string | null }>();
          if (!current || current.observedDigest !== expectedObservedDigest || current.approvedDigest !== expectedObservedDigest) {
            return Response.json({ error: "The observed cache revision changed; refresh before approving it" }, { status: 409 });
          }
        }
      } else if (action === "requestCharacter") {
        const slug = cleanText(body.slug, 80).toLowerCase();
        if (!petSlugPattern.test(slug)) return Response.json({ error: "Use the pet slug shown in the Codex Pets catalog" }, { status: 400 });
        const command = `npx @astandrik/codex-pets install ${slug}`;
        await d1.batch([
          d1.prepare(`INSERT OR IGNORE INTO character_packs (
            id, display_name, description, source_url, install_command, cache_status
          ) VALUES (?, ?, ?, ?, ?, 'requested')`)
            .bind(slug, slug.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
              "Requested from the Codex Pets catalog.", `https://codex-pets.net/pets/${slug}`, command),
          d1.prepare("INSERT INTO activity (message, tone) SELECT ?, 'neutral' WHERE changes() > 0")
            .bind(`Training Center queued the ${slug} character pack for import.`),
        ]);
      } else if (action === "confirmCharacterCached") {
        const slug = cleanText(body.slug, 80).toLowerCase();
        const character = await d1.prepare("SELECT display_name AS displayName FROM character_packs WHERE id = ?")
          .bind(slug).first<{ displayName: string }>();
        if (!character) return Response.json({ error: "Character request not found" }, { status: 404 });
        await d1.batch([
          d1.prepare(`UPDATE character_packs SET cache_status = 'cached', spritesheet_path = ?,
            cached_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND cache_status != 'cached'`).bind(`/characters/${slug}/spritesheet.webp`, slug),
          d1.prepare("INSERT INTO activity (message, tone) SELECT ?, 'success' WHERE changes() > 0")
            .bind(`${character.displayName} was confirmed in the character cache.`),
        ]);
      } else {
        return Response.json({ error: "Unknown Training Center action" }, { status: 400 });
      }
    }

    return Response.json(await readTraining(request));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Training Center action failed";
    if (/idx_training_skills_package_ref|UNIQUE constraint failed: training_center_skills\.package_ref/i.test(message)) {
      return Response.json(await readTraining(request));
    }
    if (/idx_training_skills_folder|UNIQUE constraint failed: training_center_skills\.folder_key/i.test(message)) {
      if (replayPackageRef) {
        const replay = await env.DB.prepare("SELECT id FROM training_center_skills WHERE package_ref = ?")
          .bind(replayPackageRef).first();
        if (replay) return Response.json(await readTraining(request));
      }
      return Response.json({ error: "Another skill already owns that case-insensitive global cache folder; use a package with a unique skill suffix" }, { status: 409 });
    }
    if (/idx_employee_skills_employee_folder|UNIQUE constraint failed: employee_skills\.employee_id, employee_skills\.folder_key/i.test(message)) {
      return Response.json({ error: "That workspace skill folder is still reserved for this employee" }, { status: 409 });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}
