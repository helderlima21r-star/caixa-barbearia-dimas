(function () {
"use strict";
const $ = s => document.querySelector(s);
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const BRL0 = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const money = v => BRL.format(v || 0);
const money0 = v => BRL0.format(Math.round(v || 0));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const DIA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const PAGS = ["Pix", "Dinheiro", "Cartão"];
const DEFAULT_SERVICOS = [
  { nome: "Corte", preco: 40 }, { nome: "Barba", preco: 30 }, { nome: "Corte + barba", preco: 60 },
  { nome: "Pezinho", preco: 15 }, { nome: "Sobrancelha", preco: 15 }, { nome: "Corte infantil", preco: 35 }
];

/* ---------- Supabase ---------- */
const CFG = window.CAIXA_CONFIG || {};
const configurado = CFG.supabaseUrl && !/COLE_AQUI/.test(CFG.supabaseUrl) && CFG.supabaseAnonKey && !/COLE_AQUI/.test(CFG.supabaseAnonKey);
const sb = configurado ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

/* ---------- estado ---------- */
const S = { itens: [], produtos: {}, servicos: [], tab: "caixa", periodo: "semana", carregando: true, user: null, ocupado: false };

const fromRow = r => ({ id: r.id, d: r.dia, h: r.hora, t: r.tipo === "produto" ? "p" : "s", n: r.nome, ref: r.ref, v: Number(r.valor), q: r.qtd, pg: r.pagamento, ex: r.exemplo, mp: r.mp_payment_id || null });
const prodFromRow = r => ({ id: r.id, nome: r.nome, preco: Number(r.preco), estoque: r.estoque, minimo: r.minimo, ex: r.exemplo });

async function carregarTudo() {
  const since = ymd(addMonths(new Date(), -12));
  const itens = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("lancamentos").select("*").gte("dia", since).order("dia").order("hora").range(from, from + 999);
    if (error) throw error;
    itens.push(...data.map(fromRow));
    if (data.length < 1000) break;
  }
  const [pr, sv] = await Promise.all([
    sb.from("produtos").select("*").order("nome"),
    sb.from("servicos").select("*").order("ordem")
  ]);
  if (pr.error) throw pr.error; if (sv.error) throw sv.error;
  S.itens = itens;
  S.produtos = Object.fromEntries(pr.data.map(r => [r.id, prodFromRow(r)]));
  if (!sv.data.length) {
    const { data, error } = await sb.from("servicos").insert(DEFAULT_SERVICOS.map((s, i) => ({ ...s, ordem: i }))).select();
    S.servicos = error ? [] : data.map(r => ({ id: r.id, nome: r.nome, preco: Number(r.preco) }));
  } else S.servicos = sv.data.map(r => ({ id: r.id, nome: r.nome, preco: Number(r.preco) }));
  S.carregando = false;
}
async function recarregar() {
  try { await carregarTudo(); } catch (e) { erroRede(e); }
  render();
}
function erroRede(e) {
  console.error(e);
  const msg = String(e && (e.message || e)).includes("estoque_insuficiente") ? "Não tem estoque suficiente desse produto." : "Não consegui falar com o servidor. Confira a internet e tente de novo.";
  toast(msg);
}

/* ---------- login ---------- */
function telaLogin(modo) {
  modo = modo || "entrar";
  $("#shell").hidden = true; const L = $("#login"); L.hidden = false;
  if (!configurado) {
    L.innerHTML = `<main class="login" style="padding-left:16px;padding-right:16px"><img class="logo" src="icons/logo.png" alt="Dimas Corts"><h1>Falta configurar</h1>
      <p class="muted">Preencha o arquivo <b>config.js</b> com a Project URL e a chave anon public do Supabase.</p></main>`;
    return;
  }
  L.innerHTML = `<main class="login" style="padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))">
    <img class="logo" src="icons/logo.png" alt="Dimas Corts">
    <form id="lf" class="stack" novalidate>
      <label class="f">E-mail<input class="input" id="le" type="email" autocomplete="email" required></label>
      <label class="f">Senha<input class="input" id="lp" type="password" autocomplete="${modo === "entrar" ? "current-password" : "new-password"}" minlength="6" required></label>
      <div class="erro" id="lerr" role="alert"></div>
      <button class="btn primary full" id="lb">${modo === "entrar" ? "Entrar" : "Criar conta"}</button>
    </form>
    <button class="linkbtn" id="lt" style="align-self:center">${modo === "entrar" ? "Primeira vez? Criar conta" : "Já tenho conta. Entrar"}</button>
  </main>`;
  $("#lt").onclick = () => telaLogin(modo === "entrar" ? "criar" : "entrar");
  $("#lf").onsubmit = async ev => {
    ev.preventDefault();
    const email = $("#le").value.trim(), password = $("#lp").value, err = $("#lerr"), b = $("#lb");
    if (!email || password.length < 6) { err.textContent = "Digite o e-mail e uma senha com pelo menos 6 caracteres."; return; }
    b.disabled = true; err.textContent = "";
    const r = modo === "entrar" ? await sb.auth.signInWithPassword({ email, password }) : await sb.auth.signUp({ email, password });
    b.disabled = false;
    if (r.error) {
      const m = r.error.message || "";
      err.textContent = /Invalid login/i.test(m) ? "E-mail ou senha errados." : /confirm/i.test(m) ? "Confirme o e-mail pelo link que chegou na sua caixa de entrada." : /registered/i.test(m) ? "Esse e-mail já tem conta. Use Entrar." : "Não deu certo: " + m;
      return;
    }
    if (modo === "criar" && !r.data.session) { err.style.color = "var(--ok)"; err.textContent = "Conta criada. Abra o link que chegou no seu e-mail e depois entre aqui."; }
  };
}
async function entrouCom(user) {
  if (S.user && S.user.id === user.id) return;
  S.user = user; S.carregando = true;
  $("#login").hidden = true; $("#shell").hidden = false; render();
  await recarregar();
}
function saiu() { S.user = null; S.itens = []; S.produtos = {}; S.servicos = []; telaLogin("entrar"); }

/* ---------- dados derivados ---------- */
const itensEntre = (a, b) => S.itens.filter(it => it.d >= a && it.d <= b);
const total = it => (Number(it.v) || 0) * (Number(it.q) || 1);
function soma(lista) {
  let s = 0, p = 0, ns = 0, np = 0;
  for (const it of lista) { if (it.t === "p") { p += total(it); np += (it.q || 1); } else { s += total(it); ns++; } }
  return { s, p, t: s + p, ns, np };
}
const temExemplo = () => S.itens.some(i => i.ex) || Object.values(S.produtos).some(p => p.ex);
const agora = () => { const n = new Date(); return { dia: ymd(n), hora: pad(n.getHours()) + ":" + pad(n.getMinutes()) }; };

/* ---------- ações ---------- */
async function ocupar(fn) {
  if (S.ocupado) return; S.ocupado = true;
  document.querySelectorAll("#overlay .btn").forEach(b => b.disabled = true);
  try { await fn(); } catch (e) { erroRede(e); } finally { S.ocupado = false; }
}
function registrarServico(serv, valor, pg) {
  return ocupar(async () => {
    const { dia, hora } = agora();
    const { data, error } = await sb.from("lancamentos").insert({ dia, hora, tipo: "servico", nome: serv.nome, ref: serv.id, valor, qtd: 1, pagamento: pg }).select().single();
    if (error) throw error;
    S.itens.push(fromRow(data)); closeSheet(); render(); toast("Registrado: " + serv.nome + " · " + money(valor));
  });
}
function registrarProduto(prod, q, pg) {
  return ocupar(async () => {
    const { dia, hora } = agora();
    const { data, error } = await sb.rpc("vender_produto", { p_produto: prod.id, p_qtd: q, p_pagamento: pg, p_dia: dia, p_hora: hora });
    if (error) throw error;
    S.itens.push(fromRow(data));
    S.produtos[prod.id] = { ...prod, estoque: Math.max(0, prod.estoque - q) };
    closeSheet(); render(); toast("Registrado: " + prod.nome + " · " + money(prod.preco * q));
  });
}
function apagarItem(it) {
  return ocupar(async () => {
    const { error } = await sb.rpc("apagar_lancamento", { p_id: it.id });
    if (error) throw error;
    S.itens = S.itens.filter(x => x.id !== it.id);
    if (it.t === "p" && S.produtos[it.ref]) S.produtos[it.ref] = { ...S.produtos[it.ref], estoque: S.produtos[it.ref].estoque + (it.q || 1) };
    closeSheet(); render(); toast("Lançamento apagado");
  });
}
async function ajustaEstoque(id, d) {
  const p = S.produtos[id]; if (!p) return;
  const novo = Math.max(0, (p.estoque || 0) + d); if (novo === p.estoque) return;
  S.produtos[id] = { ...p, estoque: novo }; render();
  const { error } = await sb.from("produtos").update({ estoque: novo }).eq("id", id);
  if (error) { S.produtos[id] = p; render(); erroRede(error); }
}
async function salvarProduto(p) {
  const body = { nome: p.nome, preco: p.preco, estoque: p.estoque, minimo: p.minimo };
  const r = p.id ? await sb.from("produtos").update(body).eq("id", p.id).select().single() : await sb.from("produtos").insert(body).select().single();
  if (r.error) throw r.error;
  S.produtos[r.data.id] = prodFromRow(r.data);
}
async function excluirProduto(id) {
  const { error } = await sb.from("produtos").delete().eq("id", id);
  if (error) throw error; delete S.produtos[id];
}
async function salvarServicos(lista) {
  const atuais = new Set(S.servicos.map(s => s.id));
  const manter = lista.filter(s => s.id).map(s => s.id);
  const remover = [...atuais].filter(id => !manter.includes(id));
  if (remover.length) { const r = await sb.from("servicos").delete().in("id", remover); if (r.error) throw r.error; }
  for (let i = 0; i < lista.length; i++) {
    const s = lista[i], body = { nome: s.nome, preco: s.preco, ordem: i };
    const r = s.id ? await sb.from("servicos").update(body).eq("id", s.id) : await sb.from("servicos").insert(body);
    if (r.error) throw r.error;
  }
  const { data, error } = await sb.from("servicos").select("*").order("ordem");
  if (error) throw error;
  S.servicos = data.map(r => ({ id: r.id, nome: r.nome, preco: Number(r.preco) }));
}
async function carregarExemplos() {
  const prods = [["Pomada matte", 45, 9, 3], ["Óleo para barba", 38, 2, 3], ["Shampoo anticaspa", 32, 14, 4], ["Minoxidil 5%", 65, 0, 2], ["Balm pós-barba", 29, 6, 3]]
    .map(([nome, preco, estoque, minimo]) => ({ nome, preco, estoque, minimo, exemplo: true }));
  const pr = await sb.from("produtos").insert(prods).select(); if (pr.error) throw pr.error;
  const svcs = S.servicos.length ? S.servicos : DEFAULT_SERVICOS;
  const pesos = [.45, .12, .25, .08, .05, .05];
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const pick = () => { let r = rnd(), c = 0; for (let i = 0; i < svcs.length; i++) { c += pesos[i] || .05; if (r <= c) return svcs[i]; } return svcs[0]; };
  const now = new Date(), hoje = new Date(now.getFullYear(), now.getMonth(), now.getDate()), ini = addMonths(hoje, -6);
  const rows = [];
  for (let d = new Date(ini); d < hoje; d = addDays(d, 1)) {
    const wd = d.getDay(); if (wd === 0) continue;
    const n = Math.round((wd === 6 ? 14 : wd === 5 ? 11 : wd === 1 ? 5 : 8) * (1 + (d - ini) / (hoje - ini) * .25) * (.75 + rnd() * .5));
    for (let i = 0; i < n; i++) {
      const h = pad(9 + Math.floor(rnd() * 10)) + ":" + pad(Math.floor(rnd() * 60)), s = pick(), pg = rnd() < .6 ? "Pix" : rnd() < .5 ? "Dinheiro" : "Cartão";
      rows.push({ dia: ymd(d), hora: h, tipo: "servico", nome: s.nome, ref: s.id || null, valor: s.preco, qtd: 1, pagamento: pg, exemplo: true });
      if (rnd() < .18) { const p = pr.data[Math.floor(rnd() * pr.data.length)]; rows.push({ dia: ymd(d), hora: h, tipo: "produto", nome: p.nome, ref: p.id, valor: p.preco, qtd: rnd() < .85 ? 1 : 2, pagamento: pg, exemplo: true }); }
    }
  }
  for (let i = 0; i < rows.length; i += 500) { const r = await sb.from("lancamentos").insert(rows.slice(i, i + 500)); if (r.error) throw r.error; }
  await carregarTudo();
}
async function removerExemplos() {
  const a = await sb.from("lancamentos").delete().eq("exemplo", true); if (a.error) throw a.error;
  const b = await sb.from("produtos").delete().eq("exemplo", true); if (b.error) throw b.error;
  await carregarTudo();
}

/* ---------- UI: abas ---------- */
document.querySelectorAll("nav.tabs button").forEach(b => b.addEventListener("click", () => {
  S.tab = b.dataset.tab; history.replaceState(null, "", "#" + S.tab); window.scrollTo(0, 0); render();
}));
const validTabs = ["caixa", "relatorios", "produtos", "ajustes"];
function fromHash() { const h = (location.hash || "").slice(1); if (validTabs.includes(h)) S.tab = h; }
window.addEventListener("hashchange", () => { fromHash(); render(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.user && !S.ocupado) recarregar(); });

let toastT = null;
function toast(msg) {
  let el = $("#toast"); if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2600);
}

function render() {
  if (!S.user) return;
  const now = new Date();
  $("#hoje-data").textContent = DIA[now.getDay()] + ", " + now.getDate() + " de " + MES[now.getMonth()];
  document.querySelectorAll("nav.tabs button").forEach(b => { if (b.dataset.tab === S.tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  $("#titulo").textContent = { caixa: "Caixa", relatorios: "Relatórios", produtos: "Produtos", ajustes: "Serviços e conta" }[S.tab];
  $("#pill-ex").hidden = !temExemplo();
  const v = $("#view");
  if (S.carregando) { v.innerHTML = '<div class="card empty">Abrindo o caixa…</div>'; return; }
  ({ caixa: viewCaixa, relatorios: viewRel, produtos: viewProd, ajustes: viewAjustes })[S.tab](v);
}

/* ---------- Caixa (hoje) ---------- */
function viewCaixa(v) {
  const hoje = ymd(new Date());
  const itens = itensEntre(hoje, hoje).sort((a, b) => b.h.localeCompare(a.h));
  const r = soma(itens), rs = soma(itensEntre(ymd(inicioSemana(new Date())), hoje));
  v.innerHTML = `
    <section class="today" aria-label="Resumo de hoje">
      <div class="eyebrow">Faturamento de hoje</div>
      <div class="big num">${money(r.t)}</div>
      <div class="split num">
        <div><b>${r.ns}</b><span>serviços</span></div>
        <div><b>${money0(r.p)}</b><span>em produtos</span></div>
        <div><b>${money0(rs.t)}</b><span>na semana</span></div>
      </div>
    </section>
    <div class="actions">
      <button class="btn primary" id="add-s"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Serviço</button>
      <button class="btn secondary" id="add-p"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"/></svg>Produto</button>
    </div>
    <section class="card">
      <div class="row between" style="margin-bottom:4px"><h2>Lançamentos de hoje</h2><span class="muted small num">${itens.length}</span></div>
      <div class="list">${itens.length ? itens.map(itemRow).join("") :
      `<div class="empty">Nenhum lançamento ainda hoje.<br>Toque em <b>Serviço</b> depois de cada atendimento.</div>`}</div>
    </section>
    ${!S.itens.length && !Object.keys(S.produtos).length ? `<section class="card stack"><h2>Quer ver os gráficos funcionando?</h2><p class="small muted" style="margin:0">Carregue 6 meses de lançamentos de exemplo. Depois é só remover na aba Serviços.</p><button class="btn ghost full" id="ex-load">Carregar dados de exemplo</button></section>` : ""}`;
  $("#add-s").onclick = () => sheetServico();
  $("#add-p").onclick = () => sheetProduto();
  const ex = $("#ex-load"); if (ex) ex.onclick = () => { ex.disabled = true; ex.textContent = "Carregando…"; ocupar(async () => { await carregarExemplos(); render(); toast("Exemplos carregados"); }).then(render); };
  v.querySelectorAll(".item").forEach(b => b.onclick = () => { const it = itens.find(x => x.id === b.dataset.id); if (it) sheetItem(it); });
}
function itemRow(it) {
  const extra = it.t === "p" ? (it.q > 1 ? it.q + " × " + money(it.v) + " · " : "") + (it.pg || "") : (it.pg || "");
  return `<button class="item" data-id="${esc(it.id)}"><span class="h num">${esc(it.h)}</span>
    <span style="min-width:0"><div class="n"><span class="dot ${it.t === "p" ? "p" : "s"}"></span>${esc(it.n)}</div><div class="sub">${esc(extra)}${it.mp ? " · Mercado Pago" : ""}${it.ex ? " · exemplo" : ""}${it.n === "A classificar" ? ' <span class="pill warn">toque para classificar</span>' : ""}</div></span>
    <span class="v num">${money(total(it))}</span></button>`;
}

/* ---------- folhas ---------- */
function openSheet(html, bind) {
  $("#overlay").innerHTML = `<div class="scrim" data-close></div><div class="sheet" role="dialog" aria-modal="true"><div class="sheet-inner"><div class="grab"></div>${html}</div></div>`;
  $("#overlay").querySelectorAll("[data-close]").forEach(e => e.onclick = closeSheet);
  bind && bind($("#overlay .sheet"));
}
function closeSheet() { $("#overlay").innerHTML = ""; }
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });
const chipsHtml = (id, sel) => `<div class="chips" id="${id}">${PAGS.map(p => `<button class="chip" data-v="${p}" aria-pressed="${p === sel}">${p}</button>`).join("")}</div>`;
function bindChips(root, id, on) { root.querySelectorAll("#" + id + " .chip").forEach(c => c.onclick = () => { root.querySelectorAll("#" + id + " .chip").forEach(x => x.setAttribute("aria-pressed", "false")); c.setAttribute("aria-pressed", "true"); on(c.dataset.v); }); }
const num = s => { const n = parseFloat(String(s || "").replace(/\./g, "").replace(",", ".")); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const fmtIn = v => String(v ?? "").replace(".", ",");

function sheetServico() {
  let sel = null, pg = "Pix";
  const lista = S.servicos;
  openSheet(`
    <div class="row between"><h2>Registrar serviço</h2><button class="linkbtn" data-close>Fechar</button></div>
    <div class="tiles">${lista.map(s => `<button class="tile" data-id="${esc(s.id)}" aria-pressed="false"><b>${esc(s.nome)}</b><span class="muted num">${money(s.preco)}</span></button>`).join("")}</div>
    <div class="grid2">
      <label class="f">Valor cobrado<input class="input num" id="sv-valor" inputmode="decimal" placeholder="0,00"></label>
      <div class="f">Pagamento${chipsHtml("sv-pg", pg)}</div>
    </div>
    <button class="btn primary full" id="sv-ok" disabled>Escolha um serviço</button>`, root => {
    const val = root.querySelector("#sv-valor"), ok = root.querySelector("#sv-ok");
    const upd = () => { const n = num(val.value); ok.disabled = !sel || !(n > 0); ok.textContent = sel ? "Registrar " + money(n) : "Escolha um serviço"; };
    root.querySelectorAll(".tile").forEach(t => t.onclick = () => {
      root.querySelectorAll(".tile").forEach(x => x.setAttribute("aria-pressed", "false")); t.setAttribute("aria-pressed", "true");
      sel = lista.find(s => s.id === t.dataset.id); val.value = fmtIn(sel.preco); upd();
    });
    val.oninput = upd; bindChips(root, "sv-pg", v => { pg = v; });
    ok.onclick = () => registrarServico(sel, num(val.value), pg);
  });
}

function sheetProduto() {
  const prods = Object.values(S.produtos).sort((a, b) => a.nome.localeCompare(b.nome));
  if (!prods.length) { openSheet(`<h2>Nenhum produto cadastrado</h2><p class="muted">Cadastre os produtos que você vende, com preço e estoque, na aba Produtos.</p><button class="btn primary full" id="go">Ir para Produtos</button>`, r => r.querySelector("#go").onclick = () => { closeSheet(); S.tab = "produtos"; render(); }); return; }
  let sel = null, q = 1, pg = "Pix";
  openSheet(`
    <div class="row between"><h2>Venda de produto</h2><button class="linkbtn" data-close>Fechar</button></div>
    <div class="tiles">${prods.map(p => `<button class="tile" data-id="${esc(p.id)}" aria-pressed="false" ${(p.estoque || 0) <= 0 ? "disabled" : ""}><b>${esc(p.nome)}</b><span class="muted num">${money(p.preco)} · ${p.estoque || 0} em estoque</span></button>`).join("")}</div>
    <div class="row between"><span class="muted small">Quantidade</span><div class="stepper"><button id="qmenos" aria-label="Menos">−</button><span id="q" class="num">1</span><button id="qmais" aria-label="Mais">+</button></div></div>
    ${chipsHtml("pv-pg", pg)}
    <button class="btn secondary full" id="pv-ok" disabled>Escolha um produto</button>`, root => {
    const ok = root.querySelector("#pv-ok"), qel = root.querySelector("#q");
    const max = () => sel ? Math.max(1, sel.estoque || 0) : 99;
    const upd = () => { qel.textContent = q; ok.disabled = !sel; ok.textContent = sel ? "Registrar " + money(sel.preco * q) : "Escolha um produto"; };
    root.querySelectorAll(".tile").forEach(t => t.onclick = () => { root.querySelectorAll(".tile").forEach(x => x.setAttribute("aria-pressed", "false")); t.setAttribute("aria-pressed", "true"); sel = S.produtos[t.dataset.id]; q = Math.min(q, max()); upd(); });
    root.querySelector("#qmenos").onclick = () => { q = Math.max(1, q - 1); upd(); };
    root.querySelector("#qmais").onclick = () => { q = Math.min(max(), q + 1); upd(); };
    bindChips(root, "pv-pg", v => { pg = v; });
    ok.onclick = () => registrarProduto(sel, q, pg);
  });
}
function sheetItem(it) {
  const classificar = it.t !== "p" && S.servicos.length;
  openSheet(`<h2>${esc(it.n)}</h2>
    <p class="muted num">${esc(it.h)} · ${esc(it.pg || "")} · ${money(total(it))}${it.t === "p" ? " · " + it.q + " un." : ""}${it.mp ? " · veio do Mercado Pago" : ""}</p>
    ${it.t === "p" ? '<p class="small muted">Apagar devolve a quantidade ao estoque.</p>' : ""}
    ${classificar ? `<div class="eyebrow">${it.n === "A classificar" ? "Qual serviço foi?" : "Trocar o serviço"}</div>
      <div class="tiles">${S.servicos.map(s => `<button class="tile" data-sid="${esc(s.id)}" aria-pressed="${s.id === it.ref}"><b>${esc(s.nome)}</b><span class="muted num">${money(s.preco)}</span></button>`).join("")}</div>` : ""}
    <div class="grid2"><button class="btn ghost" data-close>Fechar</button><button class="btn danger" id="del">Apagar lançamento</button></div>`,
    r => {
      r.querySelector("#del").onclick = () => apagarItem(it);
      r.querySelectorAll("[data-sid]").forEach(b => b.onclick = () => classificarItem(it, S.servicos.find(s => s.id === b.dataset.sid)));
    });
}
function classificarItem(it, serv) {
  if (!serv) return;
  return ocupar(async () => {
    const { error } = await sb.from("lancamentos").update({ nome: serv.nome, ref: serv.id }).eq("id", it.id);
    if (error) throw error;
    const x = S.itens.find(i => i.id === it.id); if (x) { x.n = serv.nome; x.ref = serv.id; }
    closeSheet(); render(); toast("Classificado como " + serv.nome);
  });
}

/* ---------- Relatórios ---------- */
function inicioSemana(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); return addDays(x, -((x.getDay() + 6) % 7)); }
function periodo(p) {
  const now = new Date(), hoje = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (p === "dia") {
    const buckets = []; for (let i = 13; i >= 0; i--) { const d = addDays(hoje, -i); buckets.push({ a: ymd(d), b: ymd(d), label: i === 0 ? "hoje" : String(d.getDate()), cur: i === 0 }); }
    return { nome: "Hoje", a: ymd(hoje), b: ymd(hoje), pa: ymd(addDays(hoje, -7)), pb: ymd(addDays(hoje, -7)), cmp: "mesmo dia da semana passada", buckets, chartTitle: "Últimos 14 dias" };
  }
  if (p === "semana") {
    const ini = inicioSemana(hoje), buckets = [];
    for (let i = 0; i < 7; i++) { const d = addDays(ini, i); buckets.push({ a: ymd(d), b: ymd(d), label: DIA[d.getDay()], cur: ymd(d) === ymd(hoje), fut: d > hoje }); }
    return { nome: "Esta semana", a: ymd(ini), b: ymd(hoje), pa: ymd(addDays(ini, -7)), pb: ymd(addDays(hoje, -7)), cmp: "mesmo trecho da semana passada", buckets, chartTitle: "Seg a dom" };
  }
  if (p === "mes") {
    const ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1), fim = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0), buckets = [];
    for (let d = new Date(ini); d <= fim; d = addDays(d, 1)) { const n = d.getDate(); buckets.push({ a: ymd(d), b: ymd(d), label: (n === 1 || n % 5 === 0) ? String(n) : "", cur: ymd(d) === ymd(hoje), fut: d > hoje }); }
    const pIni = addMonths(ini, -1), pFim = new Date(pIni.getFullYear(), pIni.getMonth(), Math.min(hoje.getDate(), new Date(pIni.getFullYear(), pIni.getMonth() + 1, 0).getDate()));
    return { nome: MES[hoje.getMonth()] + " " + hoje.getFullYear(), a: ymd(ini), b: ymd(hoje), pa: ymd(pIni), pb: ymd(pFim), cmp: "mesmo trecho de " + MES[pIni.getMonth()], buckets, chartTitle: "Por dia do mês" };
  }
  const buckets = []; for (let i = 5; i >= 0; i--) { const m = addMonths(hoje, -i), f = new Date(m.getFullYear(), m.getMonth() + 1, 0); buckets.push({ a: ymd(m), b: ymd(f), label: MES[m.getMonth()], cur: i === 0 }); }
  const ini = addMonths(hoje, -5);
  return { nome: "Últimos 6 meses", a: ymd(ini), b: ymd(hoje), pa: ymd(addMonths(hoje, -11)), pb: ymd(addDays(ini, -1)), cmp: "6 meses anteriores", buckets, chartTitle: "Por mês" };
}
function deltaHtml(cur, prev, label) {
  if (!prev) return `<span class="delta muted">sem dado para comparar</span>`;
  const d = (cur - prev) / prev * 100, up = d >= 0;
  return `<span class="delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(d).toFixed(0)}% vs ${esc(label)}</span>`;
}
function agrupa(lista, porQtd) {
  const m = {}; lista.forEach(i => { const k = i.n; m[k] = m[k] || { n: k, c: 0, v: 0 }; m[k].c += porQtd ? (i.q || 1) : 1; m[k].v += total(i); });
  return Object.values(m).sort((a, b) => b.v - a.v);
}
function viewRel(v) {
  const P = periodo(S.periodo), itens = itensEntre(P.a, P.b), r = soma(itens), rp = soma(itensEntre(P.pa, P.pb));
  const ticket = r.ns ? r.s / r.ns : 0;
  const series = P.buckets.map(b => { const x = soma(itensEntre(b.a, b.b)); return { ...b, s: x.s, p: x.p }; });
  const servs = agrupa(itens.filter(i => i.t !== "p"), false), prods = agrupa(itens.filter(i => i.t === "p"), true);
  const porPag = {}; itens.forEach(i => { const k = i.pg || "Outro"; porPag[k] = (porPag[k] || 0) + total(i); });
  const pags = Object.entries(porPag).sort((a, b) => b[1] - a[1]).map(([n, v]) => ({ n, v }));
  const dias = new Set(itens.map(i => i.d)).size;
  v.innerHTML = `
    <div class="seg" role="group" aria-label="Período">
      ${[["dia", "Dia"], ["semana", "Semana"], ["mes", "Mês"], ["semestre", "Semestre"]].map(([k, l]) => `<button data-p="${k}" aria-pressed="${S.periodo === k}">${l}</button>`).join("")}
    </div>
    <div class="kpis num">
      <div class="kpi main blue"><span class="eyebrow">${esc(P.nome)} · faturamento</span><b>${money(r.t)}</b>${deltaHtml(r.t, rp.t, P.cmp)}</div>
      <div class="kpi green"><span class="eyebrow">Serviços</span><b>${money0(r.s)}</b><span class="small muted">${r.ns} atendimentos</span></div>
      <div class="kpi orange"><span class="eyebrow">Produtos</span><b>${money0(r.p)}</b><span class="small muted">${r.np} unidades</span></div>
      <div class="kpi"><span class="eyebrow">Ticket médio</span><b>${money(ticket)}</b><span class="small muted">por serviço</span></div>
      <div class="kpi"><span class="eyebrow">${S.periodo === "dia" ? "Atendimentos" : "Média por dia"}</span><b>${S.periodo === "dia" ? r.ns : money0(dias ? r.t / dias : 0)}</b><span class="small muted">${S.periodo === "dia" ? "hoje" : dias + " dias trabalhados"}</span></div>
    </div>
    <section class="card chart">
      <div class="row between" style="margin-bottom:8px"><h2>${esc(P.chartTitle)}</h2>
        <div class="legend"><span><span class="dot s"></span>Serviços</span><span><span class="dot p"></span>Produtos</span></div></div>
      ${barChart(series)}
    </section>
    <section class="card"><h2 style="margin-bottom:12px">Serviços mais feitos</h2>${rank(servs, "var(--svc)", x => x.c + "×") || '<p class="muted small">Nenhum serviço neste período.</p>'}</section>
    <section class="card"><h2 style="margin-bottom:12px">Produtos vendidos</h2>${rank(prods, "var(--prd)", x => x.c + " un.") || '<p class="muted small">Nenhuma venda de produto neste período.</p>'}</section>
    <section class="card"><h2 style="margin-bottom:12px">Formas de pagamento</h2>${rank(pags, "var(--brass)", () => "") || '<p class="muted small">Sem lançamentos.</p>'}</section>`;
  v.querySelectorAll(".seg button").forEach(b => b.onclick = () => { S.periodo = b.dataset.p; render(); });
}
function rank(arr, color, sub) {
  if (!arr.length) return "";
  const tot = arr.reduce((a, x) => a + x.v, 0) || 1, max = arr[0].v || 1;
  return `<div class="bars">${arr.slice(0, 8).map(x => `<div class="barrow num"><span>${esc(x.n)} <span class="muted small">${sub(x)}</span></span><span><b>${money0(x.v)}</b> <span class="muted small">${Math.round(x.v / tot * 100)}%</span></span><div class="track"><div class="fill" style="width:${(x.v / max * 100).toFixed(1)}%;background:${color}"></div></div></div>`).join("")}</div>`;
}
function niceMax(m) { if (m <= 0) return 100; const p = Math.pow(10, Math.floor(Math.log10(m))), f = m / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
function barChart(series) {
  const W = 340, H = 190, L = 40, R = 6, T = 10, B = 24, iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(...series.map(s => s.s + s.p)));
  const n = series.length, slot = iw / n, bw = Math.max(3, Math.min(28, slot * 0.62));
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const val = max * i / 4, y = T + ih - ih * i / 4;
    g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
    g += `<text x="${L - 6}" y="${y + 3}" text-anchor="end">${val >= 1000 ? (val / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "k" : Math.round(val)}</text>`;
  }
  series.forEach((s, i) => {
    const x = L + slot * i + (slot - bw) / 2, hs = ih * s.s / max, hp = ih * s.p / max, y0 = T + ih, op = s.fut ? .25 : 1;
    if (hs > 0) g += `<rect x="${x}" y="${y0 - hs}" width="${bw}" height="${hs}" rx="2" fill="var(--svc)" opacity="${op}"><title>${esc(s.label || s.a)}: ${money(s.s + s.p)}</title></rect>`;
    if (hp > 0) g += `<rect x="${x}" y="${y0 - hs - hp}" width="${bw}" height="${hp}" rx="2" fill="var(--prd)" opacity="${op}"/>`;
    if (s.label) g += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" style="${s.cur ? "fill:var(--gold);font-weight:700" : ""}">${esc(s.label)}</text>`;
    if (s.cur && (s.s + s.p) > 0 && n <= 14) g += `<text x="${x + bw / 2}" y="${y0 - hs - hp - 4}" text-anchor="middle" style="fill:var(--ink);font-weight:600">${money0(s.s + s.p).replace("R$", "").trim()}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de faturamento">${g}</svg>`;
}

/* ---------- Produtos ---------- */
function viewProd(v) {
  const prods = Object.values(S.produtos).sort((a, b) => a.nome.localeCompare(b.nome));
  const now = new Date(), ini = ymd(new Date(now.getFullYear(), now.getMonth(), 1)), hoje = ymd(now);
  const vendasMes = {}; itensEntre(ini, hoje).filter(i => i.t === "p").forEach(i => { vendasMes[i.ref] = (vendasMes[i.ref] || 0) + (i.q || 1); });
  const valorEstoque = prods.reduce((a, p) => a + (p.preco || 0) * (p.estoque || 0), 0);
  const baixos = prods.filter(p => (p.estoque || 0) <= (p.minimo ?? 3)).length;
  v.innerHTML = `
    <div class="kpis num">
      <div class="kpi blue"><span class="eyebrow">Em estoque</span><b>${money0(valorEstoque)}</b><span class="small muted">a preço de venda</span></div>
      <div class="kpi orange"><span class="eyebrow">Repor</span><b>${baixos}</b><span class="small muted">${baixos === 1 ? "produto acabando" : "produtos acabando"}</span></div>
    </div>
    <section class="card">
      <div class="row between" style="margin-bottom:4px"><h2>Seus produtos</h2><button class="linkbtn" id="novo">+ Novo produto</button></div>
      ${prods.length ? prods.map(p => {
        const e = p.estoque || 0, min = p.minimo ?? 3;
        const st = e <= 0 ? '<span class="pill bad">Esgotado</span>' : e <= min ? '<span class="pill warn">Acabando</span>' : '<span class="pill ok">Ok</span>';
        return `<div class="prod"><div style="min-width:0"><div class="row" style="gap:8px;flex-wrap:wrap"><b>${esc(p.nome)}</b>${st}${p.ex ? '<span class="pill ex">exemplo</span>' : ""}</div>
          <div class="small muted num">${money(p.preco)} · ${vendasMes[p.id] || 0} vendidos em ${MES[now.getMonth()]} · <button class="linkbtn" data-edit="${esc(p.id)}">editar</button></div></div>
          <div class="stepper num"><button data-m="${esc(p.id)}" aria-label="Tirar 1 do estoque">−</button><span>${e}</span><button data-p="${esc(p.id)}" aria-label="Adicionar 1 ao estoque">+</button></div></div>`;
      }).join("") : `<div class="empty">Cadastre pomadas, óleos, shampoos e o que mais você vende. O estoque baixa sozinho a cada venda.</div>`}
    </section>
    <p class="small muted">Use − e + para acertar o estoque quando chegar mercadoria ou faltar algo.</p>`;
  $("#novo").onclick = () => sheetEditProd(null);
  v.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => sheetEditProd(S.produtos[b.dataset.edit]));
  v.querySelectorAll("[data-m]").forEach(b => b.onclick = () => ajustaEstoque(b.dataset.m, -1));
  v.querySelectorAll("[data-p]").forEach(b => b.onclick = () => ajustaEstoque(b.dataset.p, 1));
}
function sheetEditProd(p) {
  const novo = !p;
  openSheet(`<div class="row between"><h2>${novo ? "Novo produto" : "Editar produto"}</h2><button class="linkbtn" data-close>Fechar</button></div>
    <label class="f">Nome<input class="input" id="pn" value="${esc(p?.nome || "")}" placeholder="Ex.: Pomada matte"></label>
    <div class="grid2">
      <label class="f">Preço de venda<input class="input num" id="pp" inputmode="decimal" value="${p ? fmtIn(p.preco) : ""}" placeholder="0,00"></label>
      <label class="f">Estoque atual<input class="input num" id="pe" inputmode="numeric" value="${p?.estoque ?? ""}" placeholder="0"></label>
    </div>
    <label class="f">Avisar quando tiver só<input class="input num" id="pmin" inputmode="numeric" value="${p?.minimo ?? 3}"></label>
    <button class="btn primary full" id="psave">Salvar</button>
    ${novo ? "" : `<button class="btn ghost full" id="pdel" style="color:var(--bad)">Excluir produto</button>`}`, r => {
    r.querySelector("#psave").onclick = () => {
      const nome = r.querySelector("#pn").value.trim(); if (!nome) { r.querySelector("#pn").focus(); return; }
      const np = { id: p?.id, nome, preco: num(r.querySelector("#pp").value), estoque: Math.max(0, parseInt(r.querySelector("#pe").value) || 0), minimo: Math.max(0, parseInt(r.querySelector("#pmin").value) || 0) };
      ocupar(async () => { await salvarProduto(np); closeSheet(); render(); toast("Produto salvo"); });
    };
    const d = r.querySelector("#pdel"); if (d) d.onclick = () => {
      if (d.dataset.sure) ocupar(async () => { await excluirProduto(p.id); closeSheet(); render(); toast("Produto excluído"); });
      else { d.dataset.sure = "1"; d.textContent = "Toque de novo para excluir"; d.className = "btn danger full"; }
    };
  });
}

/* ---------- Serviços e conta ---------- */
function viewAjustes(v) {
  const lista = S.servicos;
  v.innerHTML = `
    <section class="card">
      <p class="small muted" style="margin:0 0 10px">Estes são os botões que aparecem ao registrar um serviço. O valor pode ser ajustado na hora.</p>
      <div class="stack">${lista.map((s, i) => `<div class="grid2" style="grid-template-columns:1fr 96px 34px;gap:8px;align-items:center">
        <input class="input" id="sn-${i}" value="${esc(s.nome)}" aria-label="Nome do serviço">
        <input class="input num" id="sp-${i}" inputmode="decimal" value="${fmtIn(s.preco)}" aria-label="Preço">
        <button class="linkbtn" data-rm="${i}" aria-label="Remover ${esc(s.nome)}" style="color:var(--bad);font-size:20px">×</button></div>`).join("")}</div>
      <div class="grid2" style="margin-top:14px"><button class="btn ghost" id="sadd">+ Serviço</button><button class="btn primary" id="ssave">Salvar preços</button></div>
    </section>
    ${temExemplo() ? `<section class="card stack"><h2>Dados de exemplo</h2><p class="small muted" style="margin:0">Os lançamentos marcados como exemplo servem só para ver os gráficos funcionando. Remova antes de começar a usar de verdade.</p><button class="btn danger full" id="rmex">Remover dados de exemplo</button></section>` : ""}
    <section class="card stack"><h2>Conta</h2><p class="small muted" style="margin:0">Conectado como <b>${esc(S.user?.email || "")}</b>. Os dados ficam salvos no servidor e aparecem em qualquer celular em que você entrar com essa conta.</p><button class="btn ghost full" id="sair">Sair</button></section>`;
  const lerLista = () => lista.map((s, i) => ({ id: s.id, nome: ($("#sn-" + i)?.value || "").trim(), preco: num($("#sp-" + i)?.value) })).filter(s => s.nome);
  $("#sadd").onclick = () => { S.servicos = [...lerLista(), { id: null, nome: "Novo serviço", preco: 0 }]; render(); };
  v.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { const l = lerLista(); l.splice(+b.dataset.rm, 1); S.servicos = l; render(); });
  $("#ssave").onclick = () => ocupar(async () => { await salvarServicos(lerLista()); render(); toast("Preços salvos"); });
  const rm = $("#rmex"); if (rm) rm.onclick = () => { if (rm.dataset.sure) ocupar(async () => { await removerExemplos(); render(); toast("Exemplos removidos"); }); else { rm.dataset.sure = "1"; rm.textContent = "Toque de novo para confirmar"; } };
  $("#sair").onclick = () => sb.auth.signOut();
}

/* ---------- início ---------- */
fromHash();
if (!sb) telaLogin();
else {
  sb.auth.onAuthStateChange((ev, session) => { if (session?.user) entrouCom(session.user); else saiu(); });
  sb.auth.getSession().then(({ data }) => { if (data.session?.user) entrouCom(data.session.user); else telaLogin("entrar"); });
}
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
