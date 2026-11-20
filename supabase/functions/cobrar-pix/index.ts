// Cria uma cobrança Pix no Mercado Pago para o usuário logado e devolve o QR Code.
// Segredos necessários (Edge Functions → Secrets): MP_ACCESS_TOKEN.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ erro: "metodo" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ erro: "login" }, 401);
  const user = u.user;

  let body: { nome?: string; ref?: string; valor?: number };
  try { body = await req.json(); } catch { return json({ erro: "corpo" }, 400); }
  const nome = String(body.nome || "").slice(0, 80).trim();
  const valor = Math.round(Number(body.valor) * 100) / 100;
  if (!nome || !(valor > 0) || valor > 10000) return json({ erro: "dados" }, 400);

  const mpToken = Deno.env.get("MP_ACCESS_TOKEN");
  if (!mpToken) return json({ erro: "sem_mercado_pago" }, 500);

  const { data: cob, error: ce } = await admin.from("cobrancas")
    .insert({ owner: user.id, servico_nome: nome, servico_ref: body.ref || null, valor })
    .select().single();
  if (ce) return json({ erro: "banco", detalhe: ce.message }, 500);

  const expira = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace("Z", "-00:00");
  const r = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: { Authorization: `Bearer ${mpToken}`, "Content-Type": "application/json", "X-Idempotency-Key": cob.id },
    body: JSON.stringify({
      transaction_amount: valor,
      description: nome,
      payment_method_id: "pix",
      external_reference: cob.id,
      date_of_expiration: expira,
      notification_url: `${url}/functions/v1/mp-webhook`,
      payer: { email: user.email },
    }),
  });
  const mp = await r.json().catch(() => ({}));
  if (!r.ok) {
    await admin.from("cobrancas").update({ status: "cancelado" }).eq("id", cob.id);
    return json({ erro: "mercado_pago", detalhe: mp?.message || r.status }, 502);
  }
  const td = mp?.point_of_interaction?.transaction_data || {};
  await admin.from("cobrancas").update({ mp_payment_id: String(mp.id), qr_code: td.qr_code, qr_base64: td.qr_code_base64 }).eq("id", cob.id);
  return json({ id: cob.id, qr_code: td.qr_code, qr_base64: td.qr_code_base64, valor });
});
