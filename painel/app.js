(function () {
"use strict";
/* Painel do robô do WhatsApp: conversas, agenda e avisos. Mesmo login e mesmo Supabase do Caixa. */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const TZ = "America/Sao_Paulo";
const fmtHora = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtDia = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long", day: "2-digit", month: "2-digit" });
const fmtCurto = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const fmtYmd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const ymdSP = d => fmtYmd.format(d); // "2026-11-25" no horário de São Paulo
const hora = d => fmtHora.format(new Date(d));
// O Brasil não tem horário de verão desde 2019: São Paulo é sempre UTC-3.
const instante = (ymd, hhmm) => new Date(`${ymd}T${hhmm}:00-03:00`);
const somarDias = (ymd, n) => ymdSP(new Date(instante(ymd, "12:00").getTime() + n * 86400000));
const diaSemana = ymd => instante(ymd, "12:00").getUTCDay();
const DIA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const DIAS_AGENDA = [2, 3, 4]; // terça a quinta
const JANELA_MS = 24 * 3600 * 1000;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function telefone(wa) {
  const d = String(wa || "").replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4), n = d.slice(4);
    return `(${ddd}) ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
  }
  return "+" + d;
}
const nomeDe = c => (c && c.nome) || telefone(c && c.wa_id);
const inicial = c => (c && c.nome ? c.nome.trim()[0] : "#").toUpperCase();
function quandoCurto(iso) {
  if (!iso) return "";
  const d = new Date(iso), hoje = ymdSP(new Date()), dia = ymdSP(d);
  if (dia === hoje) return hora(d);
  if (dia === somarDias(hoje, -1)) return "ontem";
  return fmtCurto.format(d);
}

/* ---------- Supabase ---------- */
const CFG = window.CAIXA_CONFIG || {};
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });

async function acao(nome, dados) {
  const { data, error } = await sb.functions.invoke("painel", { body: { acao: nome, ...(dados || {}) } });
  if (error) {
    let msg = "Sem conexão. Tente de novo.";
    try { const j = await error.context.json(); if (j && j.erro) msg = j.erro; } catch (_) { /* resposta sem JSON */ }
    throw new Error(msg);
  }
  return data;
}

/* ---------- estado ---------- */
const S = {
  user: null, tab: "conversas", filtro: "todas",
  convs: [], carregando: true,
  aberta: null, msgs: [], carregandoMsgs: false,
  dia: null, ags: [], bloqs: [], agCarregando: false,
  push: "?"
};
const conv = wa => S.convs.find(c => c.wa_id === wa);
const esperando = c => !!c.aguardando_desde;
const pausado = c => c.pausado_ate && new Date(c.pausado_ate) > new Date();

let toastT;
function toast(t) {
  let el = $(".toast"); if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
  el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- login ---------- */
function telaLogin(aviso) {
  $("#shell").hidden = true; $("#chat").hidden = true;
  const L = $("#login"); L.hidden = false;
  L.innerHTML = `<main class="login" style="padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))">
    <img class="logo" src="../icons/logo.png" alt="Dimas Corts">
    <div><div class="eyebrow" style="color:var(--gold)">Painel do robô</div><p class="muted" style="margin:4px 0 0">Entre com o mesmo e-mail e senha do Caixa.</p></div>
    <form id="lf" class="stack" novalidate>
      <label class="f">E-mail<input class="input" id="le" type="email" autocomplete="email" required></label>
      <label class="f">Senha<input class="input" id="lp" type="password" autocomplete="current-password" required></label>
      <div class="erro" id="lerr" role="alert">${esc(aviso || "")}</div>
      <button class="btn primary full" id="lb">Entrar</button>
    </form>
  </main>`;
  $("#lf").onsubmit = async ev => {
    ev.preventDefault();
    const email = $("#le").value.trim(), password = $("#lp").value, err = $("#lerr"), b = $("#lb");
    if (!email || !password) { err.textContent = "Digite o e-mail e a senha."; return; }
    b.disabled = true; err.textContent = "";
    const r = await sb.auth.signInWithPassword({ email, password });
    b.disabled = false;
    if (r.error) err.textContent = /Invalid login/i.test(r.error.message) ? "E-mail ou senha errados." : "Não deu certo: " + r.error.message;
  };
}

async function entrouCom(user) {
  if (S.user && S.user.id === user.id) return;
  const adm = await sb.from("robo_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!adm.data) {
    await sb.auth.signOut();
    telaLogin(adm.error ? "Não deu para conferir o acesso. Tente de novo." : "Esta conta não tem acesso ao painel do robô.");
    return;
  }
  S.user = user;
  $("#login").hidden = true; $("#shell").hidden = false;
  render();
  await carregarConversas();
  ouvirMudancas();
  estadoPush();
  const c = new URLSearchParams(location.search).get("c");
  if (c) abrirConversa(c);
}
function saiu() {
  S.user = null; S.convs = []; S.aberta = null;
  if (canal) { sb.removeChannel(canal); canal = null; }
  telaLogin();
}

/* ---------- dados ---------- */
async function carregarConversas() {
  const { data, error } = await sb.from("robo_sessoes")
    .select("wa_id,nome,ultima_msg_em,ultima_cliente_em,ultimo_texto,ultimo_de,pausado_ate,aguardando_desde")
    .not("ultima_msg_em", "is", null)
    .order("ultima_msg_em", { ascending: false }).limit(200);
  S.carregando = false;
  if (error) { toast("Não deu para carregar as conversas."); return; }
  S.convs = data;
  atualizarBadge();
  if (S.tab === "conversas") render();
}

async function carregarMsgs(wa) {
  S.carregandoMsgs = true; renderChat();
  const { data, error } = await sb.from("robo_chat").select("*").eq("wa_id", wa).order("id", { ascending: false }).limit(300);
  S.carregandoMsgs = false;
  if (S.aberta !== wa) return;
  if (error) { toast("Não deu para carregar a conversa."); return; }
  S.msgs = data.reverse();
  renderChat(true);
}

let canal = null;
function ouvirMudancas() {
  if (canal) return;
  canal = sb.channel("painel")
    .on("postgres_changes", { event: "*", schema: "public", table: "robo_sessoes" }, p => {
      const r = p.new && p.new.wa_id ? p.new : null;
      if (!r) return;
      const i = S.convs.findIndex(c => c.wa_id === r.wa_id);
      if (i >= 0) S.convs[i] = { ...S.convs[i], ...r }; else if (r.ultima_msg_em) S.convs.push(r);
      S.convs.sort((a, b) => String(b.ultima_msg_em || "").localeCompare(String(a.ultima_msg_em || "")));
      atualizarBadge();
      if (S.aberta === r.wa_id) renderChatTopo();
      if (S.tab === "conversas" && !$("#shell").hidden) render();
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "robo_chat" }, p => {
      if (p.new.wa_id !== S.aberta) return;
      if (S.msgs.some(m => m.id === p.new.id)) return;
      S.msgs.push(p.new); renderChat(true);
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "robo_chat" }, p => {
      const m = S.msgs.find(x => x.id === p.new.id);
      if (m) { Object.assign(m, p.new); renderChat(); }
    })
    .subscribe(st => { if (st === "SUBSCRIBED" && S.user) { carregarConversas(); if (S.aberta) carregarMsgs(S.aberta); } });
}
// Voltou para o app depois de um tempo: recarrega (o celular corta a conexão em segundo plano).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !S.user) return;
  carregarConversas();
  if (S.aberta) carregarMsgs(S.aberta);
  if (S.tab === "agenda") carregarAgenda();
});

function atualizarBadge() {
  const n = S.convs.filter(esperando).length;
  const b = $("#badge"); if (b) { b.hidden = !n; b.textContent = n; }
  try { if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (_) { /* sem suporte */ }
}

/* ---------- telas ---------- */
function render() {
  document.querySelectorAll("nav.tabs button").forEach(b => { if (b.dataset.tab === S.tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  $("#titulo").textContent = { conversas: "Conversas", agenda: "Agenda", ajustes: "Avisos" }[S.tab];
  const v = $("#view");
  ({ conversas: viewConversas, agenda: viewAgenda, ajustes: viewAjustes })[S.tab](v);
}
document.querySelectorAll("nav.tabs button").forEach(b => b.onclick = () => {
  S.tab = b.dataset.tab; render(); window.scrollTo(0, 0);
  if (S.tab === "agenda") carregarAgenda();
});

function viewConversas(v) {
  const espera = S.convs.filter(esperando);
  const lista = S.filtro === "espera" ? espera : S.convs;
  let html = `<div class="seg" style="grid-template-columns:1fr 1fr">
      <button data-f="todas" aria-pressed="${S.filtro === "todas"}">Todas</button>
      <button data-f="espera" aria-pressed="${S.filtro === "espera"}">Esperando você${espera.length ? ` (${espera.length})` : ""}</button>
    </div>`;
  if (S.push === "nao" || S.push === "bloqueado") {
    html += `<button class="notice" id="ir-avisos" style="text-align:left;width:100%">🔔 Ligue os avisos para saber na hora quando um cliente chamar você. <b style="color:var(--gold)">Ligar</b></button>`;
  }
  html += `<section class="card" style="padding-block:6px">`;
  if (S.carregando) html += `<div class="empty">Carregando…</div>`;
  else if (!lista.length) html += `<div class="empty">${S.filtro === "espera" ? "Ninguém esperando resposta. 👍" : "Nenhuma conversa ainda. Quando um cliente mandar mensagem para a barbearia, ela aparece aqui."}</div>`;
  else {
    html += `<div class="list">` + lista.map(c => {
      const prefixo = c.ultimo_de === "dimas" ? "Você: " : c.ultimo_de === "robo" ? "Robô: " : "";
      return `<button class="conv${esperando(c) ? " espera" : ""}" data-wa="${esc(c.wa_id)}">
        <span class="avatar">${esc(inicial(c))}</span>
        <span class="n">${esc(nomeDe(c))}</span>
        <span class="t">${esc(quandoCurto(c.ultima_msg_em))}</span>
        <span class="u">${esperando(c) ? `<b class="pill">Esperando</b>` : pausado(c) ? `<b class="pill ok">Você atende</b>` : ""}<span>${esc(prefixo + (c.ultimo_texto || ""))}</span></span>
      </button>`;
    }).join("") + `</div>`;
  }
  html += `</section>`;
  v.innerHTML = html;
  v.querySelectorAll("[data-f]").forEach(b => b.onclick = () => { S.filtro = b.dataset.f; render(); });
  v.querySelectorAll("[data-wa]").forEach(b => b.onclick = () => abrirConversa(b.dataset.wa));
  const ia = $("#ir-avisos"); if (ia) ia.onclick = () => { S.tab = "ajustes"; render(); };
}

/* ---------- conversa ---------- */
function abrirConversa(wa) {
  S.aberta = wa; S.msgs = [];
  $("#chat").hidden = false; document.body.style.overflow = "hidden";
  $("#chat").innerHTML = `<div class="chat-top">
      <button class="voltar" id="voltar" aria-label="Voltar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="quem"><b id="c-nome"></b><a id="c-tel"></a></div>
    </div>
    <div class="robo-bar" id="robo-bar"></div>
    <div class="msgs" id="msgs"><div class="msgs-in" id="msgs-in"></div></div>
    <div class="compor" id="compor"></div>`;
  $("#voltar").onclick = fecharConversa;
  history.pushState({ chat: wa }, "", "?c=" + encodeURIComponent(wa));
  renderChatTopo(); renderCompor();
  carregarMsgs(wa);
  acao("lida", { wa_id: wa }).catch(() => {});
}
function fecharConversa(semHistorico) {
  S.aberta = null; S.msgs = [];
  $("#chat").hidden = true; $("#chat").innerHTML = ""; document.body.style.overflow = "";
  if (semHistorico !== true && history.state && history.state.chat) history.back();
  else history.replaceState(null, "", location.pathname);
  render();
}
window.addEventListener("popstate", () => { if (S.aberta) fecharConversa(true); });
navigator.serviceWorker && navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.abrir && S.user) abrirConversa(e.data.abrir); });

function renderChatTopo() {
  const c = conv(S.aberta) || { wa_id: S.aberta };
  const n = $("#c-nome"); if (!n) return;
  n.textContent = nomeDe(c);
  const t = $("#c-tel"); t.textContent = telefone(c.wa_id); t.href = "tel:+" + c.wa_id;
  const bar = $("#robo-bar");
  const p = pausado(c);
  bar.className = "robo-bar" + (p ? " pausado" : "");
  bar.innerHTML = p
    ? `<span>⏸️ Robô parado. Você atende até as ${esc(hora(c.pausado_ate))}.</span><button class="linkbtn" id="devolver">Devolver ao robô</button>`
    : `<span class="muted">🤖 O robô está respondendo.</span><button class="linkbtn" id="assumir">Assumir conversa</button>`;
  const btn = $("#devolver") || $("#assumir");
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await acao(p ? "devolver" : "assumir", { wa_id: c.wa_id });
      const x = conv(c.wa_id);
      if (x) { x.pausado_ate = p ? null : r.pausado_ate; if (p) x.aguardando_desde = null; }
      toast(p ? "O robô voltou a responder." : "Pronto: o robô fica quieto nesta conversa.");
      renderChatTopo(); atualizarBadge();
    } catch (e) { toast(e.message); btn.disabled = false; }
  };
  renderCompor();
}

function renderCompor() {
  const box = $("#compor"); if (!box) return;
  const c = conv(S.aberta) || {};
  const aberta = c.ultima_cliente_em && Date.now() - new Date(c.ultima_cliente_em).getTime() < JANELA_MS;
  const rascunho = $("#txt") ? $("#txt").value : "";
  if (!aberta) {
    box.innerHTML = `<div class="aviso">${c.ultima_cliente_em ? "Já passou 24 horas da última mensagem deste cliente. O WhatsApp só deixa você responder quando ele mandar mensagem de novo." : "Este cliente ainda não mandou mensagem."} Se for urgente, ligue: <a href="tel:+${esc(c.wa_id || S.aberta)}" style="color:var(--gold)">${esc(telefone(c.wa_id || S.aberta))}</a></div>`;
    return;
  }
  const limite = new Date(new Date(c.ultima_cliente_em).getTime() + JANELA_MS);
  box.innerHTML = `${esperando(c) ? `<div class="aviso">O cliente está esperando você. <button class="linkbtn" id="resolvido">Já resolvi</button></div>` : ""}
    <div class="compor-in">
      <textarea id="txt" rows="1" placeholder="Escreva para o cliente…" aria-label="Mensagem"></textarea>
      <button class="enviar" id="enviar" aria-label="Enviar"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 20.5 21 12 3 3.5 3 10l12 2-12 2z"/></svg></button>
    </div>
    <div class="erro small" id="c-erro" role="alert"></div>
    ${limite.getTime() - Date.now() < 3 * 3600 * 1000 ? `<div class="aviso">Você pode responder até ${esc(hora(limite))}. Depois disso, só se o cliente mandar mensagem de novo.</div>` : ""}`;
  const txt = $("#txt"); txt.value = rascunho;
  const ajusta = () => { txt.style.height = "auto"; txt.style.height = Math.min(txt.scrollHeight, 140) + "px"; };
  txt.oninput = ajusta; ajusta();
  $("#enviar").onclick = enviarMsg;
  const rs = $("#resolvido");
  if (rs) rs.onclick = async () => {
    rs.disabled = true;
    try { await acao("resolvido", { wa_id: S.aberta }); const x = conv(S.aberta); if (x) x.aguardando_desde = null; atualizarBadge(); renderCompor(); }
    catch (e) { toast(e.message); rs.disabled = false; }
  };
}

async function enviarMsg() {
  const txt = $("#txt"), b = $("#enviar"), err = $("#c-erro");
  const texto = txt.value.trim(); if (!texto) return;
  b.disabled = true; err.textContent = "";
  try {
    const r = await acao("enviar", { wa_id: S.aberta, texto });
    txt.value = ""; txt.style.height = "auto";
    const x = conv(S.aberta); if (x) { x.pausado_ate = r.pausado_ate; x.aguardando_desde = null; }
    atualizarBadge(); renderChatTopo();
    // a mensagem aparece pela atualização em tempo real; se ela demorar, recarrega
    setTimeout(() => { if (S.aberta && !S.msgs.some(m => m.de === "dimas" && m.texto === texto)) carregarMsgs(S.aberta); }, 2500);
  } catch (e) { err.textContent = e.message; }
  b.disabled = false; txt.focus();
}

// Erros comuns do WhatsApp em português
function explicaErro(e) {
  if (/^131047|^131026/.test(e)) return "Passou de 24 horas sem o cliente escrever, ou o número não tem WhatsApp.";
  if (/^130497/.test(e)) return "O WhatsApp não deixa mandar para esse país.";
  if (/^131056/.test(e)) return "Muitas mensagens seguidas para esse cliente. Espere um pouco.";
  if (/^190|^0 /.test(e)) return "O token do WhatsApp venceu. Avise o Helder.";
  return e;
}
const ROTULO_MIDIA = { imagem: "📷 Ver foto", audio: "🎤 Ouvir áudio", video: "🎬 Ver vídeo", documento: "📄 Abrir arquivo", figurinha: "Ver figurinha" };
function bolha(m) {
  const quem = m.de === "dimas" ? "Você" : m.de === "robo" ? "Robô" : "";
  let st = "";
  if (m.de !== "cliente") {
    st = m.status === "lida" ? ` <span class="lida">✓✓</span>` : m.status === "entregue" ? " ✓✓" : m.status === "falhou" ? ` <span class="falhou">⚠️ não chegou</span>` : " ✓";
  }
  let corpo = "";
  if (m.midia_id) corpo += `<button class="midia-btn" data-midia="${esc(m.midia_id)}" data-tipo="${esc(m.tipo)}" data-mime="${esc(m.midia_mime || "")}">${ROTULO_MIDIA[m.tipo] || "Abrir"}</button>`;
  const texto = m.midia_id && /^(📷|🎤|🎬|📄|Figurinha)/.test(m.texto || "") ? "" : (m.texto || "");
  // *negrito* e _itálico_ como no WhatsApp
  if (texto) corpo += esc(texto).replace(/\*([^*\n]+)\*/g, "<b>$1</b>").replace(/(^|\s)_([^_\n]+)_/g, "$1<i>$2</i>");
  const ops = m.extra && m.extra.opcoes && m.extra.opcoes.length ? `<span class="ops">${m.extra.opcoes.map(o => `<span>${esc(o)}</span>`).join("")}</span>` : "";
  const erro = m.status === "falhou" && m.erro ? `<span class="meta falhou">${esc(explicaErro(m.erro))}</span>` : "";
  return `<div class="b ${esc(m.de)}${m.tipo === "escolha" ? " escolha" : ""}">${quem ? `<span class="quem">${quem}</span>` : ""}${m.tipo === "escolha" ? "👆 " : ""}${corpo}${ops}<span class="meta">${esc(hora(m.criado_em))}${st}</span>${erro}</div>`;
}

function renderChat(rolar) {
  const box = $("#msgs-in"); if (!box) return;
  const area = $("#msgs");
  const noFim = area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  if (S.carregandoMsgs && !S.msgs.length) { box.innerHTML = `<div class="empty">Carregando…</div>`; return; }
  if (!S.msgs.length) { box.innerHTML = `<div class="empty">Nenhuma mensagem guardada ainda. As mensagens passam a aparecer aqui a partir de agora.</div>`; return; }
  let html = "", dia = "";
  for (const m of S.msgs) {
    const d = ymdSP(new Date(m.criado_em));
    if (d !== dia) { dia = d; html += `<div class="dia-sep">${d === ymdSP(new Date()) ? "Hoje" : cap(fmtDia.format(new Date(m.criado_em)))}</div>`; }
    html += bolha(m);
  }
  box.innerHTML = html;
  box.querySelectorAll("[data-midia]").forEach(b => b.onclick = () => abrirMidia(b));
  if (rolar || noFim) area.scrollTop = area.scrollHeight;
  renderCompor();
}

const midias = {};
async function abrirMidia(btn) {
  const id = btn.dataset.midia, tipo = btn.dataset.tipo;
  btn.disabled = true; btn.textContent = "Baixando…";
  try {
    if (!midias[id]) {
      const blob = await acao("midia", { id });
      if (!(blob instanceof Blob)) throw new Error("Não deu para abrir.");
      midias[id] = URL.createObjectURL(blob);
    }
    const url = midias[id];
    let el;
    if (tipo === "imagem" || tipo === "figurinha") { el = document.createElement("img"); el.alt = "Foto do cliente"; el.src = url; el.onclick = () => window.open(url); }
    else if (tipo === "audio") { el = document.createElement("audio"); el.controls = true; el.src = url; el.play().catch(() => {}); }
    else if (tipo === "video") { el = document.createElement("video"); el.controls = true; el.playsInline = true; el.src = url; }
    else { el = document.createElement("a"); el.href = url; el.download = "arquivo"; el.textContent = "📄 Baixar arquivo"; el.className = "midia-btn"; }
    btn.replaceWith(el);
    if (tipo === "audio") {
      // alguns iPhones não tocam o formato de áudio do WhatsApp: oferece baixar
      el.onerror = () => { const a = document.createElement("a"); a.href = url; a.download = "audio.ogg"; a.className = "midia-btn"; a.textContent = "🎤 Baixar áudio"; el.replaceWith(a); };
    }
  } catch (e) { btn.disabled = false; btn.textContent = ROTULO_MIDIA[tipo] || "Abrir"; toast(e.message); }
}

/* ---------- agenda ---------- */
function proximoDiaDeAgenda() {
  let d = ymdSP(new Date());
  for (let i = 0; i < 7; i++) { if (DIAS_AGENDA.includes(diaSemana(d))) return d; d = somarDias(d, 1); }
  return ymdSP(new Date());
}
async function carregarAgenda() {
  if (!S.dia) S.dia = proximoDiaDeAgenda();
  const de = instante(ymdSP(new Date()), "00:00").toISOString();
  const ate = instante(somarDias(ymdSP(new Date()), 21), "00:00").toISOString();
  S.agCarregando = true; if (S.tab === "agenda") render();
  const [a, b] = await Promise.all([
    sb.from("robo_agendamentos").select("id,wa_id,nome,servico,produtos,inicio,fim,valor,status,expira_em").gte("inicio", de).lt("inicio", ate).in("status", ["confirmado", "reservado"]).order("inicio"),
    sb.from("robo_bloqueios").select("*").gt("fim", de).order("inicio")
  ]);
  S.agCarregando = false;
  if (a.error || b.error) { toast("Não deu para carregar a agenda."); return; }
  const agora = new Date();
  S.ags = a.data.filter(x => x.status === "confirmado" || new Date(x.expira_em) > agora);
  S.bloqs = b.data;
  if (S.tab === "agenda") render();
}
const doDia = (lista, ymd) => lista.filter(x => new Date(x.inicio) < instante(somarDias(ymd, 1), "00:00") && new Date(x.fim) > instante(ymd, "00:00"));

function viewAgenda(v) {
  if (!S.dia) S.dia = proximoDiaDeAgenda();
  const hoje = ymdSP(new Date());
  let chips = "";
  for (let i = 0; i < 21; i++) {
    const d = somarDias(hoje, i), ds = diaSemana(d);
    const tem = doDia(S.ags, d).length, bloq = doDia(S.bloqs, d).length;
    chips += `<button class="dia${DIAS_AGENDA.includes(ds) ? "" : " fechado"}" data-dia="${d}" aria-pressed="${d === S.dia}">
      <small>${i === 0 ? "hoje" : DIA[ds]}</small><b>${d.slice(8)}</b><i class="${bloq ? "bloq" : tem ? "tem" : ""}"></i></button>`;
  }
  const ags = doDia(S.ags, S.dia), bls = doDia(S.bloqs, S.dia);
  const ds = diaSemana(S.dia);
  const itens = [
    ...ags.map(a => ({ t: new Date(a.inicio), html: `<div class="ag">
        <div class="h">${esc(hora(a.inicio))}<small>até ${esc(hora(a.fim))}</small></div>
        <div class="n">${esc(a.nome || telefone(a.wa_id))}</div>
        <button class="linkbtn" data-wa="${esc(a.wa_id)}">Conversa</button>
        <div class="s">${esc(a.servico)}${(a.produtos || []).length ? ` + 🛍️ ${esc(a.produtos.map(p => p.nome).join(", "))}` : ""} · ${esc(BRL.format(a.valor))} ${a.status === "reservado" ? `<b class="pill warn">esperando o Pix</b>` : `<b class="pill ok">pago</b>`}</div>
      </div>` })),
    ...bls.map(b => {
      const diaTodo = new Date(b.inicio) <= instante(S.dia, "00:00") && new Date(b.fim) >= instante(somarDias(S.dia, 1), "00:00");
      return { t: new Date(b.inicio), html: `<div class="ag bloq">
        <div class="h">${diaTodo ? "🚫" : esc(hora(b.inicio))}${diaTodo ? "" : `<small>até ${esc(hora(b.fim))}</small>`}</div>
        <div class="n">${diaTodo ? "Dia bloqueado" : "Horário bloqueado"}</div>
        <button class="linkbtn" data-desbloq="${esc(b.id)}">Desbloquear</button>
        <div class="s">${esc(b.motivo || "Sem motivo")} · ninguém consegue marcar</div>
      </div>` };
    })
  ];
  if (DIAS_AGENDA.includes(ds) && !bls.some(b => new Date(b.inicio) <= instante(S.dia, "13:00") && new Date(b.fim) >= instante(S.dia, "14:00"))) {
    itens.push({ t: instante(S.dia, "13:00"), html: `<div class="ag almoco"><div class="h">13:00<small>até 14:00</small></div><div class="n">Almoço</div><span></span></div>` });
  }
  itens.sort((x, y) => x.t - y.t);
  const fechado = !DIAS_AGENDA.includes(ds);
  v.innerHTML = `<div class="dias" id="dias">${chips}</div>
    <section class="card stack">
      <div class="row between"><h2>${esc(cap(fmtDia.format(instante(S.dia, "12:00"))))}</h2><span class="small muted">${ags.length} cliente${ags.length === 1 ? "" : "s"}</span></div>
      ${fechado ? `<p class="small muted" style="margin:0">${ds === 5 || ds === 6 ? "Sexta e sábado são por ordem de chegada: o robô não marca horário." : "Dia sem agenda: o robô não marca horário."}</p>` : ""}
      ${S.agCarregando && !itens.length ? `<div class="empty">Carregando…</div>` : itens.length ? `<div class="list">${itens.map(i => i.html).join("")}</div>` : fechado ? "" : `<div class="empty">Nenhum cliente marcado ainda.</div>`}
    </section>
    <button class="btn secondary full" id="bloquear">🚫 Bloquear dia ou horário</button>
    <p class="small muted" style="margin:0;text-align:center">Bloqueou? O robô para de oferecer esse horário na hora.</p>`;
  v.querySelectorAll("[data-dia]").forEach(b => b.onclick = () => { S.dia = b.dataset.dia; render(); });
  v.querySelectorAll("[data-wa]").forEach(b => b.onclick = () => abrirConversa(b.dataset.wa));
  v.querySelectorAll("[data-desbloq]").forEach(b => b.onclick = () => desbloquear(b.dataset.desbloq, b));
  $("#bloquear").onclick = () => folhaBloqueio(S.dia);
  const sel = v.querySelector('.dia[aria-pressed="true"]'); if (sel) sel.scrollIntoView({ inline: "center", block: "nearest" });
}

async function desbloquear(id, btn) {
  btn.disabled = true;
  const { error } = await sb.from("robo_bloqueios").delete().eq("id", id);
  if (error) { btn.disabled = false; toast("Não deu para desbloquear."); return; }
  S.bloqs = S.bloqs.filter(b => b.id !== id);
  toast("Desbloqueado. O robô volta a oferecer esse horário.");
  render();
}

function fecharFolha() { $("#overlay").innerHTML = ""; }
function folhaBloqueio(dia) {
  const o = $("#overlay");
  o.innerHTML = `<div class="scrim" id="scrim"></div><div class="sheet" role="dialog" aria-label="Bloquear"><div class="sheet-inner">
    <div class="grab"></div>
    <h2>Bloquear</h2>
    <label class="f">Dia<input class="input" type="date" id="b-dia" value="${dia}" min="${ymdSP(new Date())}"></label>
    <div class="chips"><button class="chip" data-modo="dia" aria-pressed="true">Dia inteiro</button><button class="chip" data-modo="horas" aria-pressed="false">Só um horário</button></div>
    <div class="grid2" id="b-horas" hidden>
      <label class="f">Das<input class="input" type="time" id="b-de" value="09:00" step="600"></label>
      <label class="f">Até<input class="input" type="time" id="b-ate" value="10:00" step="600"></label>
    </div>
    <label class="f">Motivo (só você vê)<input class="input" id="b-mot" placeholder="Ex.: médico, folga, feriado" maxlength="80"></label>
    <div class="notice" id="b-aviso" hidden></div>
    <div class="erro" id="b-erro" role="alert"></div>
    <button class="btn primary full" id="b-ok">Bloquear</button>
    <button class="btn ghost full" id="b-cancelar">Cancelar</button>
  </div></div>`;
  let modo = "dia", confirmou = false;
  $("#scrim").onclick = fecharFolha; $("#b-cancelar").onclick = fecharFolha;
  o.querySelectorAll("[data-modo]").forEach(b => b.onclick = () => {
    modo = b.dataset.modo; confirmou = false; $("#b-aviso").hidden = true; $("#b-ok").textContent = "Bloquear";
    o.querySelectorAll("[data-modo]").forEach(x => x.setAttribute("aria-pressed", x === b));
    $("#b-horas").hidden = modo !== "horas";
  });
  ["#b-dia", "#b-de", "#b-ate"].forEach(s => $(s).oninput = () => { confirmou = false; $("#b-aviso").hidden = true; $("#b-ok").textContent = "Bloquear"; });
  $("#b-ok").onclick = async () => {
    const d = $("#b-dia").value, err = $("#b-erro"); err.textContent = "";
    if (!d) { err.textContent = "Escolha o dia."; return; }
    const inicio = modo === "dia" ? instante(d, "00:00") : instante(d, $("#b-de").value || "00:00");
    const fim = modo === "dia" ? instante(somarDias(d, 1), "00:00") : instante(d, $("#b-ate").value || "00:00");
    if (!(fim > inicio)) { err.textContent = "O horário final tem que ser depois do inicial."; return; }
    const choque = S.ags.filter(a => a.status === "confirmado" && new Date(a.inicio) < fim && new Date(a.fim) > inicio);
    if (choque.length && !confirmou) {
      confirmou = true;
      $("#b-aviso").hidden = false;
      $("#b-aviso").innerHTML = `⚠️ ${choque.length === 1 ? "Já tem 1 cliente marcado" : `Já tem ${choque.length} clientes marcados`} nesse horário (${choque.map(a => esc(hora(a.inicio) + " " + (a.nome || telefone(a.wa_id)))).join(", ")}). O bloqueio <b>não cancela</b> esses horários: avise o cliente pela conversa.`;
      $("#b-ok").textContent = "Bloquear mesmo assim";
      return;
    }
    $("#b-ok").disabled = true;
    const { data, error } = await sb.from("robo_bloqueios").insert({ inicio: inicio.toISOString(), fim: fim.toISOString(), motivo: $("#b-mot").value.trim() || null }).select().single();
    if (error) { $("#b-ok").disabled = false; err.textContent = "Não deu para bloquear. Tente de novo."; return; }
    S.bloqs.push(data); S.dia = d;
    fecharFolha(); toast("Bloqueado. O robô não oferece mais esse horário."); render();
  };
}

/* ---------- avisos (notificações) ---------- */
const ehIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const instalado = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushPossivel = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function estadoPush() {
  if (!pushPossivel) { S.push = ehIOS && !instalado ? "instalar" : "sem"; return atualizaAvisos(); }
  if (Notification.permission === "denied") { S.push = "bloqueado"; return atualizaAvisos(); }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    S.push = sub && Notification.permission === "granted" ? "ligado" : "nao";
    // renova a inscrição no servidor (o navegador às vezes troca)
    if (sub && S.push === "ligado") acao("inscrever", { inscricao: sub.toJSON() }).catch(() => {});
  } catch (_) { S.push = "nao"; }
  atualizaAvisos();
}
function atualizaAvisos() { if (S.tab !== "chat" && !$("#shell").hidden) render(); }

function chaveBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
async function ligarAvisos(btn) {
  btn.disabled = true; btn.textContent = "Ligando…";
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { S.push = perm === "denied" ? "bloqueado" : "nao"; render(); return; }
    const { chave } = await acao("vapid");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveBytes(chave) });
    await acao("inscrever", { inscricao: sub.toJSON() });
    S.push = "ligado"; render();
    const r = await acao("teste");
    toast(r.ok ? "Avisos ligados! Chegou um aviso de teste." : "Avisos ligados.");
  } catch (e) { toast(e.message || "Não deu para ligar os avisos."); btn.disabled = false; btn.textContent = "Ligar avisos"; }
}

function viewAjustes(v) {
  let push;
  if (S.push === "ligado") push = `<p style="margin:0">✅ <b>Avisos ligados neste celular.</b> Quando um cliente tocar em "Falar com o Dimas" ou mandar mensagem numa conversa sua, chega um aviso aqui.</p>
    <button class="btn ghost full" id="teste">Mandar um aviso de teste</button>`;
  else if (S.push === "instalar") push = `<p style="margin:0">No iPhone, os avisos só funcionam com o painel na tela inicial:</p>
    <ol style="margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px"><li>Toque no botão <b>Compartilhar</b> do Safari (o quadrado com a seta para cima).</li><li>Toque em <b>Adicionar à Tela de Início</b> e depois em <b>Adicionar</b>.</li><li>Abra o <b>Painel Dimas</b> pelo ícone novo e volte aqui em <b>Avisos</b>.</li></ol>`;
  else if (S.push === "bloqueado") push = `<p style="margin:0">⚠️ Os avisos foram bloqueados neste celular. Para liberar, abra os <b>Ajustes do celular → Notificações</b>, ache o painel (ou o navegador) e ligue as notificações. Depois volte aqui.</p>`;
  else if (S.push === "sem") push = `<p style="margin:0">Este navegador não consegue mostrar avisos. No Android use o Chrome; no iPhone, o Safari com o painel na tela inicial.</p>`;
  else if (S.push === "?") push = `<p class="muted" style="margin:0">Conferindo…</p>`;
  else push = `<p style="margin:0">Ligue os avisos para saber na hora quando um cliente chamar você, mesmo com o celular bloqueado.</p>
    <button class="btn primary full" id="ligar">🔔 Ligar avisos</button>`;
  v.innerHTML = `<section class="card stack"><h2>Avisos no celular</h2>${push}</section>
    ${!instalado && !ehIOS ? `<section class="card stack"><h2>Ícone na tela inicial</h2><p class="small muted" style="margin:0">No Chrome, toque no menu ⋮ e em <b>Instalar app</b> ou <b>Adicionar à tela inicial</b>. Assim o painel abre como um app.</p></section>` : ""}
    <section class="card stack"><h2>Como funciona</h2>
      <ul class="small" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">
        <li>O robô responde sozinho. Você vê todas as conversas aqui.</li>
        <li>Quando o cliente toca em <b>Falar com o Dimas</b>, o robô para naquela conversa e você responde por aqui.</li>
        <li>Quando você responde, o robô fica quieto nessa conversa por 4 horas. Para ele voltar antes, toque em <b>Devolver ao robô</b>.</li>
        <li>O WhatsApp só deixa responder até 24 horas depois da última mensagem do cliente.</li>
      </ul></section>
    <section class="card stack"><h2>Conta</h2><p class="small muted" style="margin:0">Conectado como <b>${esc(S.user?.email || "")}</b>.</p>
      <a class="btn ghost full" href="../" style="text-decoration:none;color:var(--ink)">Abrir o Caixa</a>
      <button class="btn ghost full" id="sair">Sair</button></section>`;
  const l = $("#ligar"); if (l) l.onclick = () => ligarAvisos(l);
  const t = $("#teste"); if (t) t.onclick = async () => { t.disabled = true; try { const r = await acao("teste"); toast(r.ok ? "Aviso enviado. Chegou?" : "Não achei este celular. Ligue os avisos de novo."); if (!r.ok) { S.push = "nao"; render(); } } catch (e) { toast(e.message); } t.disabled = false; };
  $("#sair").onclick = () => sb.auth.signOut();
}

/* ---------- início ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
sb.auth.onAuthStateChange((ev, session) => { if (session && session.user) entrouCom(session.user); else if (ev === "SIGNED_OUT") saiu(); });
sb.auth.getSession().then(({ data }) => { if (data.session && data.session.user) entrouCom(data.session.user); else telaLogin(); });
})();
