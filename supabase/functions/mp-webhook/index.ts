// Recebe o aviso do Mercado Pago, confere o pagamento e lança no Caixa.
// Publicar SEM verificação de JWT (o Mercado Pago não manda login).
// Segredos: MP_ACCESS_TOKEN e MP_WEBHOOK_SECRET (assinatura secreta do painel de Webhooks do Mercado Pago).
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function agoraSP() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  let body: any = {};
  try { body = await req.json(); } catch { /* avisos antigos vêm só na URL */ }
  const tipo = body.type || body.topic || u.searchParams.get("type") || u.searchParams.get("topic");
  const pid = String(body?.data?.id || u.searchParams.get("data.id") || u.searchParams.get("id") || "");
  if (tipo !== "payment" || !pid) return new Response("ignorado", { status: 200 });

  // Confere a assinatura quando houver segredo configurado.
  const segredo = Deno.env.get("MP_WEBHOOK_SECRET");
  if (segredo) {
    const xs = req.headers.get("x-signature") || "";
    const rid = req.headers.get("x-request-id") || "";
    const parts = Object.fromEntries(xs.split(",").map((s) => s.trim().split("=")));
    const idUrl = (u.searchParams.get("data.id") || pid).toLowerCase();
    const manifesto = `id:${idUrl};request-id:${rid};ts:${parts.ts};`;
    if (!parts.v1 || (await hmacHex(segredo, manifesto)) !== parts.v1) return new Response("assinatura", { status: 401 });
  }

  // Nunca confia no corpo do aviso: busca o pagamento direto no Mercado Pago.
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(pid)}`, {
    headers: { Authorization: `Bearer ${Deno.env.get("MP_ACCESS_TOKEN")}` },
  });
  if (!r.ok) return new Response("consulta", { status: 502 });
  const mp = await r.json();
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const ref = mp.external_reference;
  if (!ref) return new Response("sem referencia", { status: 200 });

  if (mp.status === "cancelled" || mp.status === "expired" || mp.status === "rejected") {
    await admin.from("cobrancas").update({ status: "expirado" }).eq("id", ref).eq("status", "pendente");
    return new Response("ok", { status: 200 });
  }
  if (mp.status !== "approved") return new Response("ok", { status: 200 });

  // Marca como paga só uma vez (avisos podem chegar repetidos).
  const { data: cob } = await admin.from("cobrancas")
    .update({ status: "pago", pago_em: new Date().toISOString() })
    .eq("id", ref).in("status", ["pendente", "cancelado", "expirado"]).eq("mp_payment_id", String(mp.id))
    .select().maybeSingle();
  if (!cob) return new Response("ja processado", { status: 200 });
  if (Number(mp.transaction_amount) + 0.001 < Number(cob.valor)) return new Response("valor divergente", { status: 200 });

  const { dia, hora } = agoraSP();
  const { data: l } = await admin.from("lancamentos").insert({
    owner: cob.owner, dia, hora, tipo: "servico", nome: cob.servico_nome, ref: cob.servico_ref,
    valor: cob.valor, qtd: 1, pagamento: "Pix",
  }).select().single();
  if (l) await admin.from("cobrancas").update({ lancamento_id: l.id }).eq("id", cob.id);
  return new Response("ok", { status: 200 });
});
