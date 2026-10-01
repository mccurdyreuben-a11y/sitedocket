// Supabase Edge Function: send-docket-email
//
// Triggered from the client (SiteDocketsPage) right after a docket is
// approved and its PDF has been uploaded to Supabase Storage. Sends the
// approved PDF to both the subcontractor and the site's main contractor
// via Resend.
//
// Inputs (POST JSON body):
//   { "docketId": "<uuid>" }
//
// Required runtime secrets (set via `supabase secrets set`):
//   RESEND_API_KEY               - Resend API key (server-side only).
//   RESEND_FROM_EMAIL            - Verified "From" address (e.g. "SiteDocket <dockets@yourdomain.com>").
//   SUPABASE_URL                 - Provided automatically by the Supabase runtime.
//   SUPABASE_ANON_KEY            - Provided automatically by the Supabase runtime.
//   SUPABASE_SERVICE_ROLE_KEY    - Provided automatically by the Supabase runtime.
//
// Optional runtime secrets:
//   APP_NAME                     - Product name used in the email signature.
//                                  Defaults to "SiteDocket" when unset.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

interface SendResult {
  to: string;
  ok: boolean;
  status: number;
  id?: string;
  error?: string;
}

async function sendOneEmail(params: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  pdfBase64: string;
  pdfFilename: string;
}): Promise<SendResult> {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: params.from,
      to: [params.to],
      subject: params.subject,
      text: params.text,
      attachments: [
        {
          filename: params.pdfFilename,
          content: params.pdfBase64,
        },
      ],
    }),
  });

  let body: { id?: string; message?: string; name?: string } | null = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }

  if (!resp.ok) {
    return {
      to: params.to,
      ok: false,
      status: resp.status,
      error: body?.message || body?.name || `HTTP ${resp.status}`,
    };
  }
  return {
    to: params.to,
    ok: true,
    status: resp.status,
    id: body?.id,
  };
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const RESEND_FROM_EMAIL = Deno.env.get("RESEND_FROM_EMAIL");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const APP_NAME = Deno.env.get("APP_NAME") || "SiteDocket";

    if (!RESEND_API_KEY) {
      return jsonResponse({ error: "Missing RESEND_API_KEY secret" }, 500);
    }
    if (!RESEND_FROM_EMAIL) {
      return jsonResponse(
        { error: "Missing RESEND_FROM_EMAIL secret (verified Resend sender)" },
        500,
      );
    }
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
      return jsonResponse({ error: "Supabase runtime env vars missing" }, 500);
    }

    // --- AuthN: verify the caller's JWT ------------------------------------
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing Authorization header" }, 401);
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userResult, error: userErr } = await userClient.auth
      .getUser();
    if (userErr || !userResult?.user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const callerId = userResult.user.id;

    // --- Input -------------------------------------------------------------
    let payload: { docketId?: string };
    try {
      payload = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }
    const docketId = payload?.docketId;
    if (!docketId || typeof docketId !== "string") {
      return jsonResponse({ error: "docketId is required" }, 400);
    }

    // --- Data lookup via service role (bypasses RLS) -----------------------
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: docket, error: docketErr } = await admin
      .from("dockets")
      .select(
        "id, site_id, subcontractor_id, trade_type, work_date, pdf_url, status",
      )
      .eq("id", docketId)
      .maybeSingle();
    if (docketErr) {
      return jsonResponse(
        { error: `Could not load docket: ${docketErr.message}` },
        500,
      );
    }
    if (!docket) {
      return jsonResponse({ error: "Docket not found" }, 404);
    }
    if (!docket.pdf_url) {
      return jsonResponse(
        { error: "Docket has no pdf_url yet; cannot email" },
        400,
      );
    }

    const { data: site, error: siteErr } = await admin
      .from("sites")
      .select("id, name, contractor_id")
      .eq("id", docket.site_id)
      .maybeSingle();
    if (siteErr || !site) {
      return jsonResponse(
        { error: `Could not load site: ${siteErr?.message ?? "not found"}` },
        500,
      );
    }

    // --- AuthZ: only the site's contractor can trigger this ----------------
    if (site.contractor_id !== callerId) {
      return jsonResponse(
        { error: "Not authorized: caller is not the site's contractor" },
        403,
      );
    }

    const [{ data: subUser }, { data: contractorUser }] = await Promise.all([
      admin
        .from("users")
        .select("id, name, email, company_name")
        .eq("id", docket.subcontractor_id)
        .maybeSingle(),
      admin
        .from("users")
        .select("id, name, email, company_name")
        .eq("id", site.contractor_id)
        .maybeSingle(),
    ]);

    if (!subUser?.email && !contractorUser?.email) {
      return jsonResponse(
        { error: "Neither subcontractor nor contractor has an email on file" },
        400,
      );
    }

    // --- Download PDF and encode as base64 ---------------------------------
    const pdfResp = await fetch(docket.pdf_url);
    if (!pdfResp.ok) {
      return jsonResponse(
        {
          error:
            `Could not download PDF from pdf_url (HTTP ${pdfResp.status})`,
        },
        502,
      );
    }
    const pdfBytes = new Uint8Array(await pdfResp.arrayBuffer());
    if (pdfBytes.byteLength === 0) {
      return jsonResponse({ error: "PDF downloaded but is empty" }, 502);
    }
    const pdfBase64 = encodeBase64(pdfBytes);

    // --- Compose subject + body --------------------------------------------
    const siteName = site.name ?? "Site";
    const workDate = docket.work_date
      ? String(docket.work_date).slice(0, 10) // YYYY-MM-DD
      : new Date().toISOString().slice(0, 10);

    const subject = `${APP_NAME} - ${siteName} - ${workDate}`;
    const pdfFilename = `site-docket-${docket.id}.pdf`;

    const bodyFor = (recipientName: string | null | undefined) =>
      [
        `Hi ${recipientName ?? "there"},`,
        "",
        `The site docket for "${siteName}" on ${workDate} has been approved.`,
        "",
        `Docket reference: ${docket.id}`,
        `Trade: ${docket.trade_type ?? "—"}`,
        "",
        "The approved docket is attached as a PDF for your records.",
        "",
        `— ${APP_NAME}`,
      ].join("\n");

    // --- Send both emails --------------------------------------------------
    const recipients: Array<{
      role: "subcontractor" | "contractor";
      email: string;
      name: string | null;
    }> = [];
    if (subUser?.email) {
      recipients.push({
        role: "subcontractor",
        email: subUser.email,
        name: subUser.name,
      });
    }
    if (contractorUser?.email) {
      recipients.push({
        role: "contractor",
        email: contractorUser.email,
        name: contractorUser.name,
      });
    }

    const results: Array<SendResult & { role: string }> = [];
    for (const r of recipients) {
      const res = await sendOneEmail({
        apiKey: RESEND_API_KEY,
        from: RESEND_FROM_EMAIL,
        to: r.email,
        subject,
        text: bodyFor(r.name),
        pdfBase64,
        pdfFilename,
      });
      results.push({ ...res, role: r.role });
    }

    const allOk = results.every((r) => r.ok);
    return jsonResponse(
      {
        ok: allOk,
        docketId,
        subject,
        sent: results,
      },
      allOk ? 200 : 502,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: `Unhandled: ${message}` }, 500);
  }
});
