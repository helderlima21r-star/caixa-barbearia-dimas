// Busca as orders pagas na conta Mercado Pago e lança no Caixa.
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
// bank_transfer = Pix

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-secret") !== Deno.env.get("SYNC_SECRET")) return new Response("proibido", { status: 401 });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // dono dos lançamentos: a conta do Dimas no app
  const email = (Deno.env.get("CAIXA_OWNER_EMAIL") || "").toLowerCase();
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const owner = users?.users.find((u) => (u.email || "").toLowerCase() === email);
  if (!owner) return new Response("conta do app nao encontrada", { status: 500 });

  // API de Orders do Mercado Pago (a de Payments está sendo descontinuada).
  // Busca as orders dos últimos 2 dias e lança as pagas ("processed" + "accredited").
  const fim = new Date(), ini = new Date(fim.getTime() - 2 * 24 * 3600 * 1000);
  const orders: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const qs = new URLSearchParams({
      begin_date: ini.toISOString(), end_date: fim.toISOString(),
      status: "processed", page: String(page), page_size: "50", sort_by: "created_date", sort_order: "desc",
    });
    const r = await fetch(`https://api.mercadopago.com/v1/orders?${qs}`, {
      headers: { Authorization: `Bearer ${Deno.env.get("MP_ACCESS_TOKEN")}`, "Content-Type": "application/json" },
    });
    if (!r.ok) return new Response("mercado pago " + r.status + " " + (await r.text()).slice(0, 300), { status: 502 });
    const j = await r.json();
    const lote = j.data || [];
    orders.push(...lote);
    if (lote.length < 50) break;
  }

  const ids = orders.map((o) => String(o.id));
  const { data: ja } = await admin.from("lancamentos").select("mp_payment_id").in("mp_payment_id", ids.length ? ids : ["-"]);
  const vistos = new Set((ja || []).map((x: any) => x.mp_payment_id));
  const { data: servs } = await admin.from("servicos").select("id,nome").eq("owner", owner.id);
  // nomes mais longos primeiro
  const lista = (servs || []).sort((a: any, b: any) => b.nome.length - a.nome.length);

  const novos = [];
  for (const o of orders) {
    const id = String(o.id);
    if (vistos.has(id) || o.status !== "processed" || o.status_detail !== "accredited") continue;
    // o robô coloca o nome do serviço na external_reference (ex.: "Corte|a1b2c3")
    const ref = norm(String(o.external_reference || "").split("|")[0].replace(/[-_]/g, " "));
    const s = lista.find((x: any) => ref.includes(norm(x.nome)));
    const pg = o.transactions?.payments?.[0] || {};
    const { dia, hora } = sp(o.last_updated_date || o.created_date);
    novos.push({
      owner: owner.id, dia, hora, tipo: "servico",
      nome: s ? s.nome : "A classificar", ref: s ? s.id : null,
      valor: Number(o.total_paid_amount || o.total_amount), qtd: 1,
      pagamento: forma(pg.payment_method?.type || ""), mp_payment_id: id,
    });
  }
  if (novos.length) {
    const { error } = await admin.from("lancamentos").upsert(novos, { onConflict: "mp_payment_id", ignoreDuplicates: true });
    if (error) return new Response("banco " + error.message, { status: 500 });
  }
  return new Response(JSON.stringify({ vistos: orders.length, novos: novos.length }), { headers: { "Content-Type": "application/json" } });
});
