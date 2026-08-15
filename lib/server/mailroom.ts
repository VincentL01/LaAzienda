import { env } from "cloudflare:workers";
import type { MailMessage, MailroomState } from "@/lib/company";
import { readWorkforce } from "./workforce";

export async function readMailroom(): Promise<MailroomState> {
  const d1 = env.DB;
  const [workforce, messages] = await Promise.all([
    readWorkforce(),
    d1.prepare(`SELECT m.id, m.message_key AS messageKey,
      m.sender_employee_id AS senderEmployeeId, sender.name AS senderName,
      sender.email_address AS senderEmail,
      m.recipient_employee_id AS recipientEmployeeId, recipient.name AS recipientName,
      recipient.email_address AS recipientEmail, m.subject, m.body, m.status, m.transport,
      m.last_error AS lastError, m.created_at AS createdAt, m.sent_at AS sentAt
      FROM mail_messages m
      JOIN employees sender ON sender.id = m.sender_employee_id
      JOIN employees recipient ON recipient.id = m.recipient_employee_id
      ORDER BY m.created_at DESC LIMIT 100`).all(),
  ]);

  return {
    employees: workforce.employees,
    roles: workforce.roles,
    runtimeProfile: workforce.runtimeProfile,
    messages: messages.results as unknown as MailMessage[],
    mailDomain: "one-man-company.test",
    transport: "stalwart",
  };
}
