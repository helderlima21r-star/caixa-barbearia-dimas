// Busca os pagamentos aprovados na conta Mercado Pago e lança no Caixa.
// Publicar SEM verificação de JWT; o acesso é protegido pelo cabeçalho x-sync-secret.
// Segredos: MP_ACCESS_TOKEN, SYNC_SECRET e CAIXA_OWNER_EMAIL (e-mail da conta do Dimas no app).
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const sp = (iso: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
};
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const forma = (t: string) => (t === "credit_card" || t === "debit_card" || t === "prepaid_card") ? "Cartão" : (t === "ticket" ? "Boleto" : "Pix");

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-secret") !== Deno.env.get("SYNC_SECRET")) return new Response("proibido", { status: 401 });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // dono dos lançamentos: a conta do Dimas no app
  const email = (Deno.env.get("CAIXA_OWNER_EMAIL") || "").toLowerCase();
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const owner = users?.users.find((u) => (u.email || "").toLowerCase() === email);
  if (!owner) return new Response("conta do app nao encontrada", { status: 500 });

  const qs = new URLSearchParams({
    sort: "date_approved", criteria: "desc", range: "date_approved",
    begin_date: "NOW-2DAYS", end_date: "NOW", status: "approved", limit: "100",
  });
  const r = await fetch(`https://api.mercadopago.com/v1/payments/search?${qs}`, {
    headers: { Authorization: `Bearer ${Deno.env.get("MP_ACCESS_TOKEN")}` },
  });
  if (!r.ok) return new Response("mercado pago " + r.status, { status: 502 });
  const { results = [] } = await r.json();

  const ids = results.map((p: any) => String(p.id));
  const { data: ja } = await admin.from("lancamentos").select("mp_payment_id").in("mp_payment_id", ids.length ? ids : ["-"]);
  const vistos = new Set((ja || []).map((x: any) => x.mp_payment_id));
  const { data: servs } = await admin.from("servicos").select("id,nome").eq("owner", owner.id);
  // nomes mais longos primeiro, para "Corte + barba" ganhar de "Corte"
  const lista = (servs || []).sort((a: any, b: any) => b.nome.length - a.nome.length);

  const novos = [];
  for (const p of results) {
    const id = String(p.id);
    if (vistos.has(id) || p.status !== "approved") continue;
    const desc = norm(`${p.description || ""} ${p.additional_info?.items?.[0]?.title || ""}`);
    const s = lista.find((x: any) => desc.includes(norm(x.nome)));
    const { dia, hora } = sp(p.date_approved || p.date_created);
    novos.push({
      owner: owner.id, dia, hora, tipo: "servico",
      nome: s ? s.nome : "A classificar", ref: s ? s.id : null,
      valor: Number(p.transaction_amount), qtd: 1, pagamento: forma(p.payment_type_id), mp_payment_id: id,
    });
  }
  if (novos.length) {
    const { error } = await admin.from("lancamentos").upsert(novos, { onConflict: "mp_payment_id", ignoreDuplicates: true });
    if (error) return new Response("banco " + error.message, { status: 500 });
  }
  return new Response(JSON.stringify({ vistos: results.length, novos: novos.length }), { headers: { "Content-Type": "application/json" } });
});
