// Função "planilha": lê a planilha de planejamento da Seille (Google Planilhas) e leva para o app
//  - o investimento diário em Facebook e Google  → aba Tráfego pago
//  - a META de cada mês e as sessões do site       → Painel (meta e conversão)
// A planilha tem uma aba por mês (JANEIRO, FEVEREIRO, ... DEZEMBRO). A função só LÊ; nunca altera a planilha.
//
// Segredos (Supabase → Edge Functions → Secrets):
//  PLANILHA_ID   o código da planilha (o trecho entre /d/ e /edit no link). Pode ter mais de um, separados por vírgula.
// A planilha precisa estar com "Qualquer pessoa com o link: Leitor".
// Ao publicar, desligue "Verify JWT": a função confere sozinha quem é membro.
import { createClient } from "npm:@supabase/supabase-js@2";

const chaveDoJson = (nome: string) => { try { const o = JSON.parse(Deno.env.get(nome) ?? "{}"); return String(o.default ?? Object.values(o)[0] ?? ""); } catch { return ""; } };
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = chaveDoJson("SUPABASE_SECRET_KEYS") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const admin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const IDS = (Deno.env.get("PLANILHA_ID") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const MESES = ["JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO", "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO"];
const semAcento = (s: string) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

// ---------- leitura ----------
function lerCsv(txt: string): string[][] {
  const linhas: string[][] = []; let linha: string[] = [], campo = "", aspas = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (aspas) { if (c === '"') { if (txt[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += c; }
    else if (c === '"') aspas = true;
    else if (c === ",") { linha.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && txt[i + 1] === "\n") i++; linha.push(campo); linhas.push(linha); linha = []; campo = ""; }
    else campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}
// "R$ 2.405,71" → 2405.71 ; "1065" → 1065 ; "" → null
function valor(s: string): number | null {
  let t = String(s ?? "").replace(/R\$|\s|%/g, "").trim();
  if (!t || t === "-" ) return null;
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = parseFloat(t);
  return isFinite(n) ? n : null;
}
const data = (s: string) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s ?? "").trim()); return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : ""; };

const ERRO_ACESSO = "A planilha não está aberta para leitura. Em Compartilhar, deixe 'Qualquer pessoa com o link: Leitor'.";
const desfazHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
// Descobre o código (gid) de cada aba pelo nome, na visualização pública da planilha
async function listarAbas(id: string): Promise<Map<string, string>> {
  const abas = new Map<string, string>();
  try {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/htmlview`, { redirect: "follow" });
    if (!r.ok) return abas;
    const html = await r.text();
    for (const m of html.matchAll(/id="sheet-button-(\d+)"[\s\S]*?>([^<>]+)<\/a>/g)) abas.set(semAcento(desfazHtml(m[2])).toUpperCase(), m[1]);
    for (const m of html.matchAll(/name:\s*"([^"]+)"[^}]*?gid:\s*"(\d+)"/g)) if (!abas.has(semAcento(m[1]).toUpperCase())) abas.set(semAcento(m[1]).toUpperCase(), m[2]);
  } catch { /* segue com o método reserva */ }
  return abas;
}
async function baixarAba(id: string, nome: string, gid?: string): Promise<string[][] | null> {
  // 1) exportação CSV da aba (valores como aparecem na tela); 2) reserva: consulta "gviz" pelo nome da aba
  const urls = [
    ...(gid ? [`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export?format=csv&gid=${gid}`] : []),
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/gviz/tq?tqx=out:csv&headers=0&sheet=${encodeURIComponent(nome)}`,
  ];
  for (const url of urls) {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) continue;
    if ((r.headers.get("content-type") ?? "").includes("html")) throw new Error(ERRO_ACESSO);
    const linhas = lerCsv(await r.text());
    if (linhas.some((l) => l.some((c) => semAcento(c) === "data"))) return linhas;
  }
  return null;
}

type Dia = { data: string; facebook: number | null; google: number | null; sessoes: number | null; metaSessoes: number | null; metaReceita: number | null; receitaPlanilha: number | null };
type Mes = { ym: string; aba: string; meta: number | null; dias: Dia[] };

function interpretar(linhas: string[][], aba: string): Mes | null {
  // cabeçalho: linha com "Data" e alguma coluna de investimento
  const iCab = linhas.findIndex((l) => l.some((c) => semAcento(c) === "data") && l.some((c) => semAcento(c).includes("investimento")));
  if (iCab < 0) return null;
  const cab = linhas[iCab].map(semAcento);
  const col = (...nomes: string[]) => cab.findIndex((c) => nomes.some((n) => c === n || c.includes(n)));
  const cData = cab.findIndex((c) => c === "data");
  const cFb = col("investimento facebook", "investimento meta", "facebook");
  const cGg = col("investimento google", "google");
  const cSess = cab.findIndex((c) => c === "sessoes");
  const cMetaSess = col("meta sessoes");
  const cMetaRec = col("meta de receita", "meta receita");
  const cRec = col("receita captada");

  // META do mês: célula "META" acima do cabeçalho, valor na primeira célula preenchida à direita
  let meta: number | null = null;
  for (const l of linhas.slice(0, iCab)) {
    const i = l.findIndex((c) => semAcento(c) === "meta");
    if (i >= 0) { for (const c of l.slice(i + 1)) { const v = valor(c); if (v != null) { meta = v; break; } } if (meta != null) break; }
  }

  const dias: Dia[] = [];
  for (const l of linhas.slice(iCab + 1)) {
    const d = data(l[cData]); if (!d) continue;
    const pega = (c: number) => (c >= 0 ? valor(l[c]) : null);
    dias.push({ data: d, facebook: pega(cFb), google: pega(cGg), sessoes: pega(cSess), metaSessoes: pega(cMetaSess), metaReceita: pega(cMetaRec), receitaPlanilha: pega(cRec) });
  }
  if (!dias.length) return null;
  // o mês é o mais frequente nas datas (protege contra a planilha devolver outra aba)
  const conta: Record<string, number> = {}; dias.forEach((d) => (conta[d.data.slice(0, 7)] = (conta[d.data.slice(0, 7)] ?? 0) + 1));
  const ym = Object.entries(conta).sort((a, b) => b[1] - a[1])[0][0];
  return { ym, aba, meta, dias: dias.filter((d) => d.data.startsWith(ym)) };
}

async function sincronizar() {
  if (!IDS.length) throw new Error("Falta o segredo PLANILHA_ID no Supabase.");
  const meses = new Map<string, Mes>();
  for (const id of IDS) {
    const abas = await listarAbas(id);
    for (const nome of MESES) {
      const chave = semAcento(nome).toUpperCase();
      // com a lista de abas, só baixa as que existem; sem ela, tenta todas pelo nome
      if (abas.size && ![...abas.keys()].some((k) => k === chave || k.startsWith(chave + " "))) continue;
      const gid = abas.get(chave) ?? [...abas.entries()].find(([k]) => k.startsWith(chave + " "))?.[1];
      const tentativas = nome === "MARÇO" ? ["MARÇO", "MARCO"] : [nome];
      for (const t of tentativas) {
        const linhas = await baixarAba(id, t, gid);
        if (!linhas) continue;
        const m = interpretar(linhas, t);
        // a aba precisa ser mesmo daquele mês (o Google devolve a primeira aba quando o nome não existe)
        if (m && +m.ym.slice(5, 7) === MESES.indexOf(nome) + 1) { meses.set(m.ym, m); break; }
      }
    }
  }
  if (!meses.size) throw new Error("Nenhuma aba de mês foi encontrada na planilha (ex.: NOVEMBRO, com a coluna Data e as colunas de investimento).");

  // tráfego: uma linha por dia e plataforma; substitui o que veio da planilha antes nesses meses
  const yms = [...meses.keys()];
  const antigos: string[] = [];
  for (const ym of yms) {
    const { data: rows } = await admin.from("docs").select("id").eq("col", "trafego").like("id", `pl-${ym}-%`);
    (rows ?? []).forEach((r: any) => antigos.push(r.id));
  }
  const agora = new Date().toISOString();
  const trafego: any[] = [], metas: any[] = [];
  let investido = 0, nDias = 0;
  for (const m of meses.values()) {
    const sessoesDia: Record<string, number> = {}, metaSessoesDia: Record<string, number> = {};
    for (const d of m.dias) {
      for (const [plat, v, suf] of [["Meta Ads", d.facebook, "fb"], ["Google Ads", d.google, "gg"]] as const) {
        if (v && v > 0) { trafego.push({ col: "trafego", id: `pl-${d.data}-${suf}`, data: { data: d.data, plataforma: plat, campanha: "Planilha de planejamento", investimento: Math.round(v * 100) / 100, impressoes: null, cliques: null, fonte: "planilha", criadoEm: agora }, updated_at: agora }); investido += v; }
      }
      if (d.sessoes != null) sessoesDia[d.data] = d.sessoes;
      if (d.metaSessoes != null) metaSessoesDia[d.data] = d.metaSessoes;
      nDias++;
    }
    const metaDias = m.dias.reduce((a, d) => a + (d.metaReceita ?? 0), 0);
    metas.push({ col: "metas", id: m.ym, data: { meta: m.meta ?? (metaDias || null), sessoesDia, metaSessoesDia, aba: m.aba, fonte: "planilha", atualizadoEm: agora }, updated_at: agora });
  }
  const novos = new Set(trafego.map((t) => t.id));
  const apagar = antigos.filter((id) => !novos.has(id));
  for (let i = 0; i < trafego.length; i += 300) { const { error } = await admin.from("docs").upsert(trafego.slice(i, i + 300), { onConflict: "col,id" }); if (error) throw error; }
  if (metas.length) { const { error } = await admin.from("docs").upsert(metas, { onConflict: "col,id" }); if (error) throw error; }
  if (apagar.length) await admin.from("docs").delete().eq("col", "trafego").in("id", apagar);
  return { meses: yms.sort(), dias: nDias, lancamentos: trafego.length, investido: Math.round(investido * 100) / 100 };
}

// ---------- estado guardado ----------
async function ler() { const { data } = await admin.from("integracoes").select("dados").eq("nome", "planilha").maybeSingle(); return (data?.dados ?? {}) as any; }
async function salvar(d: any) { await admin.from("integracoes").upsert({ nome: "planilha", dados: d, atualizado_em: new Date().toISOString() }); }

async function membro(req: Request): Promise<string> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return "sem_login";
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user?.email) return "login_invalido";
  const { data, error } = await admin.from("membros").select("email").ilike("email", user.email).maybeSingle();
  if (error) return "erro_membros";
  return data ? "" : "nao_membro";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ code: "invalid_argument" }, 405);
  const motivo = await membro(req);
  if (motivo) return json({ code: "not_granted", motivo }, 403);
  let b: any = {}; try { b = await req.json(); } catch { /* vazio */ }
  const d = await ler();

  if (b.acao === "status") return json({ configurado: IDS.length > 0, ...d });
  if (b.acao === "sincronizar") {
    // leitura automática (ao abrir o app) no máximo a cada 10 minutos; o botão "Atualizar agora" força
    if (!b.forcar && d.ultimaLeitura && Date.now() - Date.parse(d.ultimaLeitura) < 10 * 60_000) return json({ pulou: true, ...d });
    try {
      const r = await sincronizar();
      const novo = { ultimaLeitura: new Date().toISOString(), ...r, erro: null };
      await salvar(novo);
      return json(novo);
    } catch (e) {
      const novo = { ...d, ultimaTentativa: new Date().toISOString(), erro: String((e as Error)?.message ?? e).slice(0, 300) };
      await salvar(novo);
      return json({ code: "falha", ...novo }, 502);
    }
  }
  return json({ code: "invalid_argument" }, 400);
});
