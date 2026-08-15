import { env } from "cloudflare:workers";
import { ensureDatabase } from "@/db/ensure";
import { mailboxStatuses, mailStatuses, type MailboxStatus, type MailStatus } from "@/lib/company";
import { bridgeAuthorized } from "@/lib/server/bridge-auth";
import { readMailroom } from "@/lib/server/mailroom";

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function GET() {
  try {
    await ensureDatabase();
    return Response.json(await readMailroom());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Mailroom unavailable" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json()) as Record<string, unknown>;
    const d1 = env.DB;

    if (body.action === "queueMail") {
      const senderEmployeeId = cleanText(body.senderEmployeeId, 80) || "employee-dorothy";
      const recipientEmployeeId = cleanText(body.recipientEmployeeId, 80);
      const messageKey = cleanText(body.messageKey, 160);
      const subject = cleanText(body.subject, 160).replace(/[\r\n]+/g, " ");
      const messageBody = cleanText(body.body, 12000);
      if (!messageKey || !recipientEmployeeId || subject.length < 2 || messageBody.length < 2) {
        return Response.json({ error: "Recipient, subject, body, and message key are required" }, { status: 400 });
      }
      if (senderEmployeeId === recipientEmployeeId) {
        return Response.json({ error: "Choose another employee for Dorothy to coordinate" }, { status: 400 });
      }
      const endpoints = await d1.prepare(`SELECT id, name, email_address AS emailAddress,
        resource_access AS resourceAccess
        FROM employees WHERE id IN (?, ?)`).bind(senderEmployeeId, recipientEmployeeId)
        .all<{ id: string; name: string; emailAddress: string | null; resourceAccess: string }>();
      const sender = endpoints.results.find((employee) => employee.id === senderEmployeeId);
      const recipient = endpoints.results.find((employee) => employee.id === recipientEmployeeId);
      if (!sender || !recipient) return Response.json({ error: "Sender or recipient was not found" }, { status: 404 });
      if (!sender.emailAddress || !recipient.emailAddress) return Response.json({ error: "Both employees need a company email address" }, { status: 400 });
      if (sender.resourceAccess === "read-all") return Response.json({ error: "The Secretary is read-only and cannot send company mail" }, { status: 403 });

      const result = await d1.prepare(`INSERT OR IGNORE INTO mail_messages (
        id, message_key, sender_employee_id, recipient_employee_id, subject, body, status, transport
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'stalwart')`)
        .bind(`mail-${crypto.randomUUID()}`, messageKey, senderEmployeeId, recipientEmployeeId, subject, messageBody).run();
      if ((result.meta.changes ?? 0) > 0) {
        await d1.prepare("INSERT INTO activity (message, tone) VALUES (?, 'working')")
          .bind(`Dorothy queued “${subject}” for ${recipient.name} through the local mailroom.`).run();
      }
    } else if (body.action === "reportDelivery") {
      if (!bridgeAuthorized(request)) return Response.json({ error: "Mail bridge authorization failed" }, { status: 403 });
      const messageKey = cleanText(body.messageKey, 160);
      const status = String(body.status) as MailStatus;
      const lastError = cleanText(body.lastError, 1000) || null;
      if (!messageKey || !mailStatuses.includes(status) || status === "queued") {
        return Response.json({ error: "A valid delivery report is required" }, { status: 400 });
      }
      const message = await d1.prepare(`SELECT m.id, m.status, m.subject, recipient.name AS recipientName
        FROM mail_messages m JOIN employees recipient ON recipient.id = m.recipient_employee_id
        WHERE m.message_key = ?`).bind(messageKey)
        .first<{ id: string; status: MailStatus; subject: string; recipientName: string }>();
      if (!message) return Response.json({ error: "Message not found" }, { status: 404 });
      if (message.status !== status) {
        await d1.batch([
          d1.prepare(`UPDATE mail_messages SET status = ?, last_error = ?,
            sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(status, lastError, status, message.id),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, ?)")
            .bind(
              status === "sent"
                ? `Stalwart accepted “${message.subject}” for ${message.recipientName}.`
                : status === "failed"
                  ? `Mail delivery to ${message.recipientName} failed.`
                  : `The mail bridge is delivering “${message.subject}”.`,
              status === "sent" ? "success" : status === "failed" ? "failed" : "working",
            ),
        ]);
      }
    } else if (body.action === "reportMailbox") {
      if (!bridgeAuthorized(request)) return Response.json({ error: "Mail bridge authorization failed" }, { status: 403 });
      const employeeId = cleanText(body.employeeId, 80);
      const status = String(body.status) as MailboxStatus;
      if (!employeeId || !mailboxStatuses.includes(status)) return Response.json({ error: "A valid mailbox report is required" }, { status: 400 });
      const employee = await d1.prepare("SELECT name, email_address AS emailAddress, mailbox_status AS mailboxStatus FROM employees WHERE id = ?")
        .bind(employeeId).first<{ name: string; emailAddress: string; mailboxStatus: MailboxStatus }>();
      if (!employee) return Response.json({ error: "Employee not found" }, { status: 404 });
      if (employee.mailboxStatus !== status) {
        await d1.batch([
          d1.prepare("UPDATE employees SET mailbox_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(status, employeeId),
          d1.prepare("INSERT INTO activity (message, tone) VALUES (?, ?)")
            .bind(`${employee.emailAddress} mailbox is ${status}.`, status === "ready" ? "success" : status === "failed" ? "failed" : "neutral"),
        ]);
      }
    } else {
      return Response.json({ error: "Unknown mailroom action" }, { status: 400 });
    }

    return Response.json(await readMailroom());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Mailroom action failed" }, { status: 500 });
  }
}
