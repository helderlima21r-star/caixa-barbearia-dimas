// Busca as orders pagas na conta Mercado Pago e lança no Caixa.
// Combos ("Corte + Barba|a1b2") viram um lançamento por serviço; orders estornadas saem do Caixa.
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

// Acha o serviço pelo nome: igual primeiro, depois o nome mais longo contido no texto.
// `lista` já vem ordenada do nome mais longo para o mais curto.
const acharServico = (lista: any[], texto: string) =>
  lista.find((x: any) => norm(x.nome) === texto) ||
  lista.find((x: any) => texto.includes(norm(x.nome))) ||
  (texto.length >= 4 ? lista.find((x: any) => norm(x.nome).includes(texto)) : undefined);

// Divide o valor pago entre os serviços do combo, na proporção do preço de cada um.
// O último fica com o resto, para a soma bater exatamente com o valor pago.
const dividir = (total: number, precos: number[]) => {
  const soma = precos.reduce((a, b) => a + b, 0);
  const partes = precos.map((p) => Math.round((soma > 0 ? total * p / soma : total / precos.length) * 100) / 100);
  partes[partes.length - 1] = Math.round((total - partes.slice(0, -1).reduce((a, b) => a + b, 0)) * 100) / 100;
  return partes;
};

// Busca orders de um status nos últimos `dias` dias (até 250).
const buscarOrders = async (status: string, dias: number) => {
  const fim = new Date(), ini = new Date(fim.getTime() - dias * 24 * 3600 * 1000);
  const orders: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const qs = new URLSearchParams({
      begin_date: ini.toISOString(), end_date: fim.toISOString(),
      status, page: String(page), page_size: "50", sort_by: "created_date", sort_order: "desc",
    });
    const r = await fetch(`https://api.mercadopago.com/v1/orders?${qs}`, {
      headers: { Authorization: `Bearer ${Deno.env.get("MP_ACCESS_TOKEN")}`, "Content-Type": "application/json" },
    });
    if (!r.ok) throw new Error("mercado pago " + r.status + " " + (await r.text()).slice(0, 300));
    const j = await r.json();
    const lote = j.data || [];
    orders.push(...lote);
    if (lote.length < 50) break;
  }
  return orders;
};

Deno.serve(async (req) => {
  if (req.headers.get("x-sync-secret") !== Deno.env.get("SYNC_SECRET")) return new Response("proibido", { status: 401 });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // dono dos lançamentos: a conta do Dimas no app
  const email = (Deno.env.get("CAIXA_OWNER_EMAIL") || "").toLowerCase();
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const owner = users?.users.find((u) => (u.email || "").toLowerCase() === email);
  if (!owner) return new Response("conta do app nao encontrada", { status: 500 });

  // API de Orders do Mercado Pago (a de Payments está sendo descontinuada).
  // Pagas: orders dos últimos 2 dias ("processed" + "accredited").
  // Estornadas: últimos 14 dias, porque o robô pode devolver o dinheiro até a semana seguinte.
  let orders: any[], estornadas: any[];
  try {
    orders = await buscarOrders("processed", 2);
    estornadas = await buscarOrders("refunded", 14);
  } catch (e) {
    return new Response(String((e as Error).message), { status: 502 });
  }

  // Cada lançamento guarda o id da order; num combo, as partes ficam "id#1", "id#2"...
  const idsPossiveis = orders.flatMap((o) => { const id = String(o.id); return [id, `${id}#1`]; });
  const { data: ja } = await admin.from("lancamentos").select("mp_payment_id").in("mp_payment_id", idsPossiveis.length ? idsPossiveis : ["-"]);
  const vistos = new Set((ja || []).map((x: any) => String(x.mp_payment_id).split("#")[0]));
  const { data: servs } = await admin.from("servicos").select("id,nome,preco").eq("owner", owner.id);
  // nomes mais longos primeiro
  const lista = (servs || []).sort((a: any, b: any) => b.nome.length - a.nome.length);

  const novos = [];
  for (const o of orders) {
    const id = String(o.id);
    if (vistos.has(id) || o.status !== "processed" || o.status_detail !== "accredited") continue;
    // o robô coloca o nome do serviço na external_reference (ex.: "Corte|a1b2c3" ou "Corte + Barba|a1b2c3")
    const nomes = String(o.external_reference || "").split("|")[0].split("+")
      .map((x) => norm(x.replace(/[-_]/g, " "))).filter(Boolean);
    const achados = nomes.map((n) => acharServico(lista, n));
    const pg = o.transactions?.payments?.[0] || {};
    const { dia, hora } = sp(o.last_updated_date || o.created_date);
    const total = Number(o.total_paid_amount || o.total_amount);
    const base = { owner: owner.id, dia, hora, tipo: "servico", qtd: 1, pagamento: forma(pg.payment_method?.type || "") };

    if (achados.length > 1 && achados.every(Boolean)) {
      // combo: um lançamento por serviço, valor dividido pelo preço de cada um
      const valores = dividir(total, achados.map((s: any) => Number(s.preco) || 0));
      achados.forEach((s: any, i: number) => novos.push({ ...base, nome: s.nome, ref: s.id, valor: valores[i], mp_payment_id: `${id}#${i + 1}` }));
    } else {
      // um serviço só, ou combo com algum nome desconhecido: um lançamento com o total
      const s: any = achados.length === 1 ? achados[0] : undefined;
      novos.push({ ...base, nome: s ? s.nome : "A classificar", ref: s ? s.id : null, valor: total, mp_payment_id: id });
    }
  }
  if (novos.length) {
    const { error } = await admin.from("lancamentos").upsert(novos, { onConflict: "mp_payment_id", ignoreDuplicates: true });
    if (error) return new Response("banco " + error.message, { status: 500 });
  }

  // Estornos: tira do Caixa os lançamentos das orders devolvidas (a order inteira ou as partes do combo).
  let removidos = 0;
  const devolvidas = new Set(estornadas.map((o) => String(o.id)));
  if (devolvidas.size) {
    const desde = sp(new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString()).dia;
    const { data: doMp, error: e1 } = await admin.from("lancamentos").select("id,mp_payment_id")
      .eq("owner", owner.id).eq("tipo", "servico").gte("dia", desde).not("mp_payment_id", "is", null);
    if (e1) return new Response("banco " + e1.message, { status: 500 });
    const apagar = (doMp || []).filter((l: any) => devolvidas.has(String(l.mp_payment_id).split("#")[0])).map((l: any) => l.id);
    if (apagar.length) {
      const { error: e2 } = await admin.from("lancamentos").delete().in("id", apagar);
      if (e2) return new Response("banco " + e2.message, { status: 500 });
      removidos = apagar.length;
    }
  }

  return new Response(JSON.stringify({ vistos: orders.length, novos: novos.length, estornados: removidos }), { headers: { "Content-Type": "application/json" } });
});
