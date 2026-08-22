import { ensureDatabase } from "@/db/ensure";
import {
  clearOwnerSession,
  ownerAuthorized,
  readOwnerCredential,
  setOwnerSession,
  verifyOwnerCredential,
} from "@/lib/server/owner-auth";

const noStoreHeaders = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  return Response.json({ authorized: await ownerAuthorized(request) }, { headers: noStoreHeaders });
}

export async function POST(request: Request) {
  const input = await readOwnerCredential(request);
  if (!input.ok) {
    return Response.json({ authorized: false, error: "Owner credential request is invalid" }, {
      status: input.status,
      headers: noStoreHeaders,
    });
  }

  if (!(await verifyOwnerCredential(input.credential))) {
    return Response.json({ authorized: false, error: "Owner authorization failed" }, {
      status: 403,
      headers: noStoreHeaders,
    });
  }

  await ensureDatabase();
  const response = Response.json({ authorized: true }, { headers: noStoreHeaders });
  if (await setOwnerSession(response, request, input.credential)) return response;
  return Response.json({ authorized: false, error: "Owner session is unavailable; try again" }, {
    status: 503,
    headers: noStoreHeaders,
  });
}

export async function DELETE(request: Request) {
  const response = Response.json({ authorized: false }, { headers: noStoreHeaders });
  if (await clearOwnerSession(response, request)) return response;
  return Response.json({ authorized: false, error: "Owner session could not be revoked; try again" }, {
    status: 503,
    headers: noStoreHeaders,
  });
}
