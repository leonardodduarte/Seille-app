// Função "nuvemshop": liga a loja Nuvemshop ao app da Seille.
//
// O que ela faz:
//  - /nuvemshop/autorizar  → endereço de retorno do aplicativo na Nuvemshop. Recebe o código da instalação,
//                            troca pela chave de acesso da loja, guarda essa chave no banco (tabela "integracoes",
//                            que o app não consegue ler) e cadastra os avisos automáticos de pedido.
//  - /nuvemshop/webhook    → a Nuvemshop chama este endereço a cada pedido pago, alterado, enviado ou cancelado.
//                            A assinatura do aviso é conferida antes de qualquer coisa.
//  - POST { acao }         → chamado pelo app, só por membros logados: "status", "conectar", "sincronizar", "desconectar",
//                            e as notificações no celular: "push-chave", "push-assinar", "push-cancelar", "push-teste".
//  - Notificações: a cada venda nova que chega pelo aviso da Nuvemshop, manda uma notificação para os celulares
//    que ativaram em Ajustes. As chaves e a lista de celulares ficam na tabela "integracoes" (nome "push"),
//    criadas sozinhas na primeira vez; não precisa configurar nada.
//
// Segredos necessários (Supabase → Edge Functions → Secrets):
//  NUVEMSHOP_CLIENT_ID      ID do aplicativo criado no portal de parceiros da Nuvemshop
//  NUVEMSHOP_CLIENT_SECRET  Client Secret desse aplicativo
//  NUVEMSHOP_USER_AGENT     (opcional) nome e contato enviados à Nuvemshop, ex.: "Seille Gestao (contato@seille.com.br)"
//
// Ao publicar a função, DESLIGUE "Verify JWT" (Enforce JWT verification): a Nuvemshop não tem login no Supabase.
// A função confere sozinha quem é membro.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
// Chave de servidor: formato antigo (service_role) ou novo (SUPABASE_SECRET_KEYS, um JSON com as chaves secretas)
const chaveDoJson = (nome: string) => { try { const o = JSON.parse(Deno.env.get(nome) ?? "{}"); return String(o.default ?? Object.values(o)[0] ?? ""); } catch { return ""; } };
const SB_KEY = chaveDoJson("SUPABASE_SECRET_KEYS") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const admin = createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const CLIENT_ID = (Deno.env.get("NUVEMSHOP_CLIENT_ID") ?? "").trim();
const CLIENT_SECRET = (Deno.env.get("NUVEMSHOP_CLIENT_SECRET") ?? "").trim();
const UA = Deno.env.get("NUVEMSHOP_USER_AGENT") || "Seille Gestao (app proprio da loja)";
const API = "https://api.nuvemshop.com.br/v1";
const AUTORIZAR = "https://www.nuvemshop.com.br/apps";
const TOKEN_URL = "https://www.nuvemshop.com.br/apps/authorize/token";
const WEBHOOK_URL = `${SB_URL}/functions/v1/nuvemshop/webhook`;
const EVENTOS = ["order/paid", "order/updated", "order/packed", "order/fulfilled", "order/cancelled"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const pagina = (titulo: string, texto: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title>` +
      `<body style="font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;color:#000">` +
      `<div style="max-width:420px;padding:24px"><h1 style="font-size:22px">${titulo}</h1><p>${texto}</p></div>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

// ---------- dados guardados da integração ----------
type Dados = {
  store_id?: number; access_token?: string; scope?: string; conectado_em?: string; ultima_sync?: string;
  state?: string; state_exp?: number; voltar?: string; ultimo_erro?: string;
  ultima_busca?: { quando: string; desde: string; encontrados: number; importados: number; aguardando: number; cancelados: number; comTaxas?: number; campos?: string[] };
};
async function ler(): Promise<Dados> {
  const { data } = await admin.from("integracoes").select("dados").eq("nome", "nuvemshop").maybeSingle();
  return (data?.dados ?? {}) as Dados;
}
async function salvar(d: Dados) {
  const { error } = await admin.from("integracoes").upsert({ nome: "nuvemshop", dados: d, atualizado_em: new Date().toISOString() });
  if (error) throw error;
}

// ---------- notificações no celular (Web Push) ----------
type Assinatura = { endpoint: string; keys: { p256dh: string; auth: string }; criadoEm?: string };
type Push = { publica?: string; privada?: string; assinaturas?: Assinatura[] };
async function lerPush(): Promise<Push> {
  const { data } = await admin.from("integracoes").select("dados").eq("nome", "push").maybeSingle();
  return (data?.dados ?? {}) as Push;
}
async function salvarPush(p: Push) {
  const { error } = await admin.from("integracoes").upsert({ nome: "push", dados: p, atualizado_em: new Date().toISOString() });
  if (error) throw error;
}
async function chavesPush(): Promise<Push> {
  const p = await lerPush();
  if (p.publica && p.privada) return p;
  const k = webpush.generateVAPIDKeys();
  const novo = { ...p, publica: k.publicKey, privada: k.privateKey };
  await salvarPush(novo);
  return novo;
}
async function avisar(title: string, body: string, url = "./", tag = "") {
  const p = await lerPush();
  const subs = p.assinaturas ?? [];
  if (!subs.length || !p.publica || !p.privada) return { enviadas: 0, celulares: 0 };
  webpush.setVapidDetails("mailto:app@seille.com.br", p.publica, p.privada);
  const payload = JSON.stringify({ title, body, url, tag });
  const mortas = new Set<string>(); let enviadas = 0;
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s, payload, { TTL: 86400, urgency: "high" }); enviadas++; }
    catch (e: any) {
      if ([404, 410].includes(e?.statusCode)) mortas.add(s.endpoint); // celular desativou ou o app foi removido
      else console.error("push", e?.statusCode, e?.body ?? String(e));
    }
  }));
  if (mortas.size) { const atual = await lerPush(); await salvarPush({ ...atual, assinaturas: (atual.assinaturas ?? []).filter((s) => !mortas.has(s.endpoint)) }); }
  return { enviadas, celulares: subs.length };
}
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
type Novo = { id: string; pedido: string; cliente: string; total: number; pecas: number; pagoEm: string };

// ---------- chamadas à Nuvemshop ----------
async function ns(d: Dados, caminho: string, init: RequestInit = {}) {
  const r = await fetch(`${API}/${d.store_id}${caminho}`, {
    ...init,
    headers: { "Authentication": `bearer ${d.access_token}`, "User-Agent": UA, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  return r;
}

// ---------- taxas e juros pelo registro de transações do pedido (Nuvem Pago) ----------
// Procura em profundidade campos de taxa e de juros (só números; nada pessoal é guardado)
function somaProfunda(obj: any, re: RegExp, nivel = 0): number | null {
  if (!obj || typeof obj !== "object" || nivel > 5) return null;
  let tot = 0, achou = false;
  for (const [k, v] of Object.entries(obj)) {
    if (re.test(k) && (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())))) { tot += Math.abs(Number(v)); achou = true; }
    else if (re.test(k) && v && typeof v === "object" && ((v as any).value != null || (v as any).amount != null)) { tot += Math.abs(Number((v as any).value ?? (v as any).amount) || 0); achou = true; }
    else if (v && typeof v === "object") { const x = somaProfunda(v, re, nivel + 1); if (x != null) { tot += x; achou = true; } }
  }
  return achou ? Math.round(tot * 100) / 100 : null;
}
function caminhos(obj: any, pre = "", nivel = 0, out: string[] = []): string[] {
  if (!obj || typeof obj !== "object" || nivel > 5 || out.length > 120) return out;
  for (const [k, v] of Object.entries(obj)) {
    const c = pre ? pre + "." + k : k;
    if (v && typeof v === "object") caminhos(v, c, nivel + 1, out);
    else if (/fee|tax|interest|juro|install|parcel|net|amount|total|discount|gateway|method|value/i.test(k)) out.push(c + (typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v)) ? "=" + v : ""));
  }
  return out;
}
async function lerTransacoes(d: Dados, orderId: string) {
  const r = await ns(d, `/orders/${orderId}/transactions`);
  if (!r.ok) return { status: r.status, lista: [] as any[] };
  const j = await r.json().catch(() => null);
  const lista = Array.isArray(j) ? j : Array.isArray(j?.transactions) ? j.transactions : j ? [j] : [];
  return { status: r.status, lista };
}
const RE_TAXA_T = /(^|_)(fee|fees|gateway_fee|transaction_fee|payment_fee|processing_fee|commission|tax_amount|mdr)$/i;
const RE_JUROS_T = /(^|_)(interest|interests|installment_interest|installments_interest|interest_amount|financing_cost|financing_fee)$/i;

// Lê as transações do pedido e, se tiverem taxa/juros, anexa ao pedido para a importação usar
async function anexarTaxas(d: Dados, ped: any) {
  if (!ped?.id || !["paid", "authorized"].includes(ped.payment_status)) return;
  try {
    const t = await lerTransacoes(d, String(ped.id));
    const taxa = t.lista.reduce((a: number, x: any) => a + (somaProfunda(x, RE_TAXA_T) ?? 0), 0), juros = t.lista.reduce((a: number, x: any) => a + (somaProfunda(x, RE_JUROS_T) ?? 0), 0);
    if (taxa > 0 || juros > 0) { ped.__taxa = Math.round(taxa * 100) / 100; ped.__juros = Math.round(juros * 100) / 100; }
  } catch { /* segue sem as taxas */ }
}

// Foto do produto vendido (endereço público da imagem na Nuvemshop); só aceita https
const fotoDe = (p: any) => { const u = String(p?.image?.src ?? p?.image ?? "").trim(); return /^https:\/\//.test(u) ? u : ""; };

// ---------- conversão de pedido da Nuvemshop em linhas de "vendas" do app ----------
const UF: Record<string, string> = {
  "acre": "AC", "alagoas": "AL", "amapa": "AP", "amazonas": "AM", "bahia": "BA", "ceara": "CE", "distrito federal": "DF",
  "espirito santo": "ES", "goias": "GO", "maranhao": "MA", "mato grosso": "MT", "mato grosso do sul": "MS", "minas gerais": "MG",
  "para": "PA", "paraiba": "PB", "parana": "PR", "pernambuco": "PE", "piaui": "PI", "rio de janeiro": "RJ",
  "rio grande do norte": "RN", "rio grande do sul": "RS", "rondonia": "RO", "roraima": "RR", "santa catarina": "SC",
  "sao paulo": "SP", "sergipe": "SE", "tocantins": "TO",
};
const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const paraUF = (s: unknown) => {
  const t = String(s ?? "").trim(); if (!t) return "";
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return UF[semAcento(t)] ?? t;
};
const n = (v: unknown) => { const x = parseFloat(String(v ?? "0")); return isFinite(x) ? x : 0; };
const r2 = (v: number) => Math.round(v * 100) / 100;
const dataBR = (iso: string) => {
  try { return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }); } catch { return String(iso).slice(0, 10); }
};
const nomeProduto = (p: any) => typeof p?.name === "string" ? p.name : (p?.name?.pt ?? Object.values(p?.name ?? {})[0] ?? "Produto");
const variante = (p: any) => (Array.isArray(p?.variant_values) ? p.variant_values : [])
  .map((v: any) => typeof v === "string" ? v : (v?.pt ?? Object.values(v ?? {})[0] ?? "")).filter(Boolean).join(" / ");
const custoPeca = (p: any) => n(p.tecidoMetros) * n(p.tecidoPrecoMetro) + n(p.aviamentos) + n(p.costura) + n(p.embalagem) + n(p.outros);
const EM_ABERTO = ["Recebido", "Em produção", "Pronto"];

// Taxas e juros do pagamento, quando a Nuvemshop informa no pedido (procura nos dados do pedido e do pagamento)
const RE_TAXA = /(^|_)(fee|fees|gateway_fee|transaction_fee|payment_fee|processing_fee|commission)$/i;
const RE_JUROS = /(^|_)(interest|interests|installment_interest|financing_cost)$/i;
const ehNumero = (v: unknown) => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()));
function somaCampos(o: any, re: RegExp): number | null {
  let tot = 0, achou = false;
  const olhar = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (re.test(k) && ehNumero(v)) { tot += Math.abs(n(v)); achou = true; }
      else if (re.test(k) && v && typeof v === "object" && ehNumero((v as any).value ?? (v as any).amount)) { tot += Math.abs(n((v as any).value ?? (v as any).amount)); achou = true; }
    }
  };
  olhar(o); olhar(o?.payment_details); olhar(o?.payment); olhar(o?.payment_info);
  return achou ? r2(tot) : null;
}
// Lista (sem valores pessoais) os campos de pagamento que a loja envia, para conferir de onde vêm taxas e juros
function camposPagamento(o: any): string[] {
  const out = new Set<string>();
  const re = /pay|fee|interest|install|gateway|net|total|discount|shipping_cost|subtotal/i;
  for (const [k, v] of Object.entries(o ?? {})) if (re.test(k)) out.add(k + (v && typeof v === "object" ? "{" + Object.keys(v as object).join(",") + "}" : ""));
  return [...out].sort();
}

type Contagem = { importados: number; aguardando: number; cancelados: number; comTaxas: number; campos: string[]; novos: Novo[] };
async function importar(pedidos: any[]): Promise<Contagem> {
  const cont: Contagem = { importados: 0, aguardando: 0, cancelados: 0, comTaxas: 0, campos: camposPagamento(pedidos[0]), novos: [] };
  if (!pedidos.length) return cont;
  const { data: prods } = await admin.from("docs").select("id,data").eq("col", "produtos");
  const produtos = (prods ?? []).map((r: any) => ({ id: r.id, ...r.data, chave: semAcento(r.data?.nome ?? "") }));
  const acharProduto = (nome: string) => {
    const k = semAcento(nome.replace(/\s*\([^)]*\)\s*$/, ""));
    return produtos.find((p: any) => p.chave && p.chave === k) ?? produtos.find((p: any) => p.chave && (k.startsWith(p.chave) || p.chave.startsWith(k)));
  };

  const ids = pedidos.map((o) => String(o.id));
  const existentes = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 100) {
    const parte = ids.slice(i, i + 100);
    const { data } = await admin.from("docs").select("id,data").eq("col", "vendas").in("data->>nuvemshopId", parte);
    (data ?? []).forEach((r: any) => existentes.set(r.id, r.data));
  }

  const gravar: any[] = [], apagar: string[] = [];
  for (const o of pedidos) {
    const cancelado = o.status === "cancelled" || ["refunded", "voided"].includes(o.payment_status);
    const pago = ["paid", "authorized"].includes(o.payment_status);
    const doPedido = [...existentes.entries()].filter(([, d]) => d.nuvemshopId === String(o.id));
    if (!pago && !cancelado) { cont.aguardando++; continue; }      // aguardando pagamento: ainda não é venda
    // cancelado sem nunca ter sido pago não é venda; o que foi pago e depois cancelado/estornado entra (para o resumo do contador)
    if (cancelado && !doPedido.length && !o.paid_at) { cont.cancelados++; continue; }

    const itens: any[] = Array.isArray(o.products) ? o.products : [];
    const antes0 = doPedido[0]?.[1];
    const subtotal = itens.reduce((a, p) => a + n(p.price) * n(p.quantity), 0);
    const freteCobrado = n(o.shipping_cost_customer);
    const fretePago = o.shipping_cost_owner != null && n(o.shipping_cost_owner) > 0 ? n(o.shipping_cost_owner) : freteCobrado;
    const desconto = Math.max(0, r2(subtotal + freteCobrado - n(o.total)));
    // desconto dividido entre as peças, proporcional ao valor de cada uma (a última fica com o arredondamento)
    let descRestante = desconto;
    const descDe = (p: any, i: number) => {
      if (i === itens.length - 1) return r2(descRestante);
      const d = subtotal ? r2(desconto * n(p.price) * n(p.quantity) / subtotal) : 0; descRestante = r2(descRestante - d); return d;
    };
    const taxasApi = o.__taxa != null ? o.__taxa : somaCampos(o, RE_TAXA), jurosApi = o.__juros != null ? o.__juros : somaCampos(o, RE_JUROS);
    const parcelas = n(o.payment_details?.installments) || null;
    const cupom = (Array.isArray(o.coupon) ? o.coupon : []).map((c: any) => c?.code).filter(Boolean).join(", ");
    const end = o.shipping_address ?? {};
    // Situação de envio na Nuvemshop → status no app (a Nuvemshop é quem manda)
    //   por embalar (unpacked) → Recebido · embalado (unfulfilled/packed) → Pronto · enviado (fulfilled/shipped) → Enviado · arquivado (closed) → Entregue
    const enviado = ["shipped", "fulfilled", "delivered"].includes(o.shipping_status) || !!o.shipped_at;
    const arquivado = o.status === "closed";
    const embalado = !enviado && ["unfulfilled", "packed", "unshipped"].includes(o.shipping_status);
    const statusLoja = cancelado ? "Cancelado" : arquivado ? "Entregue" : enviado ? "Enviado" : embalado ? "Pronto" : "Recebido";
    // descontos separados, como a Nuvemshop informa: cupom, forma de pagamento (ex.: Pix) e promoções
    const dCupom = r2(n(o.discount_coupon)), dPagto = r2(n(o.discount_gateway));
    const dOutros = Math.max(0, r2(desconto - dCupom - dPagto));
    const metodo = String(o.payment_details?.method ?? o.payment_method ?? "").toLowerCase();
    const forma = /pix/.test(metodo) || /pix/i.test(String(o.gateway_name ?? "")) ? "Pix" : /credit|cartao|card/.test(metodo) ? "Cartão de crédito" : /debit/.test(metodo) ? "Cartão de débito" : /boleto|ticket/.test(metodo) ? "Boleto" : (metodo || "");
    const comum = {
      data: dataBR(o.paid_at || o.created_at), pedido: String(o.number ?? o.id),
      cliente: o.customer?.name || o.contact_name || o.billing_name || "",
      cidade: end.city || o.billing_city || "", estado: paraUF(end.province || o.billing_province),
      cupom, canal: "Nuvemshop", nuvemshopId: String(o.id), pagamento: o.gateway_name || o.gateway || "",
      envio: String((typeof o.shipping_option === "object" ? (o.shipping_option?.name ?? o.shipping_option?.code) : o.shipping_option) ?? o.shipping_option_code ?? o.shipping ?? "").slice(0, 80),
      ...(parcelas ? { parcelas } : {}),
      ...(forma ? { formaPagamento: forma } : {}),
      ...(cancelado ? { canceladoEm: o.cancelled_at ? dataBR(o.cancelled_at) : (antes0?.canceladoEm || dataBR(o.updated_at || o.created_at)), foiPago: !!o.paid_at || !!doPedido.length } : {}),
    };

    itens.forEach((p, i) => {
      const id = `ns-${o.id}-${i}`;
      const antes = existentes.get(id);
      const prod = acharProduto(nomeProduto(p));
      const novo: any = {
        ...comum,
        produtoId: antes?.produtoId || prod?.id || "",
        produtoNome: antes?.produtoId ? antes.produtoNome : (prod?.nome ?? nomeProduto(p)),
        tamanho: variante(p), qtd: n(p.quantity) || 1, precoUnit: r2(n(p.price)),
        ...(fotoDe(p) ? { imagem: fotoDe(p) } : {}),
        desconto: descDe(p, i), freteCobrado: i === 0 ? freteCobrado : 0,
        fretePago: antes ? n(antes.fretePago) : (i === 0 ? fretePago : 0),
        custoUnit: antes ? n(antes.custoUnit) : (prod ? r2(custoPeca(prod)) : 0),
        origem: antes?.origem || "Loja virtual (sem origem)",
        // "Em produção" é marcado no app enquanto o pedido ainda está por embalar; o resto segue a Nuvemshop
        status: statusLoja === "Recebido" && antes?.status === "Em produção" ? "Em produção" : statusLoja,
        criadoEm: antes?.criadoEm || new Date().toISOString(),
        ...(antes?.tipo ? { tipo: antes.tipo } : {}), // troca / devolução marcada no app
      };
      if (i === 0) { novo.descontoCupom = dCupom; novo.descontoPagamento = dPagto; novo.descontoOutros = dOutros; }
      if (taxasApi != null || jurosApi != null) {          // valores da loja
        novo.taxasPagas = i === 0 ? (taxasApi ?? 0) : 0; novo.jurosPagos = i === 0 ? (jurosApi ?? 0) : 0;
      } else if (antes && (antes.taxasPagas != null || antes.jurosPagos != null)) { // digitados no app
        novo.taxasPagas = antes.taxasPagas ?? 0; novo.jurosPagos = antes.jurosPagos ?? 0; if (antes.taxaManual) novo.taxaManual = true;
      }
      gravar.push({ col: "vendas", id, data: novo, updated_at: new Date().toISOString() });
    });
    doPedido.forEach(([id]) => { const k = Number(id.split("-").pop()); if (k >= itens.length) apagar.push(id); });
    if (cancelado) cont.cancelados++; else cont.importados++;
    if (!cancelado && !doPedido.length) { // venda que ainda não estava no app
      cont.novos.push({ id: String(o.id), pedido: comum.pedido, cliente: comum.cliente, total: n(o.total),
        pecas: itens.reduce((a, p) => a + (n(p.quantity) || 1), 0), pagoEm: o.paid_at || o.created_at || "" });
    }
    if (taxasApi != null || jurosApi != null) cont.comTaxas++;
  }
  for (let i = 0; i < gravar.length; i += 200) {
    const { error } = await admin.from("docs").upsert(gravar.slice(i, i + 200), { onConflict: "col,id" });
    if (error) throw error;
  }
  if (apagar.length) await admin.from("docs").delete().eq("col", "vendas").in("id", apagar);
  return cont;
}

async function sincronizar(d: Dados, desde: string) {
  const res = { encontrados: 0, importados: 0, aguardando: 0, cancelados: 0, comTaxas: 0, campos: [] as string[] };
  let todos = true; // pede pedidos de qualquer situação, inclusive arquivados
  for (let pag = 1; pag <= 100; pag++) {
    const q = new URLSearchParams({ per_page: "200", page: String(pag), created_at_min: `${desde}T00:00:00-03:00` });
    if (todos) q.set("status", "any");
    const r = await ns(d, `/orders?${q}`);
    if (r.status === 404) break; // passou da última página (ou nenhum pedido)
    if (!r.ok && todos && pag === 1 && (r.status === 400 || r.status === 422)) { todos = false; pag--; continue; }
    if (!r.ok) throw new Error(`Nuvemshop respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const lista = await r.json();
    if (!Array.isArray(lista) || !lista.length) break;
    res.encontrados += lista.length;
    const c = await importar(lista);
    res.importados += c.importados; res.aguardando += c.aguardando; res.cancelados += c.cancelados; res.comTaxas += c.comTaxas;
    if (!res.campos.length) res.campos = c.campos;
    if (lista.length < 200) break;
  }
  return res;
}

async function cadastrarWebhooks(d: Dados) {
  const r = await ns(d, "/webhooks");
  const atuais: any[] = r.ok ? await r.json() : [];
  for (const ev of EVENTOS) {
    if (atuais.some((w) => w.event === ev && w.url === WEBHOOK_URL)) continue;
    await ns(d, "/webhooks", { method: "POST", body: JSON.stringify({ event: ev, url: WEBHOOK_URL }) });
  }
}

// ---------- assinatura dos avisos ----------
async function assinaturaValida(corpo: string, recebida: string) {
  if (!CLIENT_SECRET || !recebida) return false;
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(CLIENT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(corpo)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const a = recebida.trim().toLowerCase();
  if (a.length !== hex.length) return false;
  let dif = 0; for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ hex.charCodeAt(i);
  return dif === 0;
}

// ---------- membros do app ----------
async function membro(req: Request): Promise<string> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return "sem_login";
  const { data: { user }, error } = await admin.auth.getUser(jwt);
  if (!user?.email) { console.error("getUser", error); return "login_invalido"; }
  const { data, error: e2 } = await admin.from("membros").select("email").ilike("email", user.email).maybeSingle();
  if (e2) { console.error("membros", e2); return "erro_membros"; }
  return data ? "" : "nao_membro";
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // 1) Retorno da instalação na Nuvemshop
  if (url.pathname.endsWith("/autorizar")) {
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state");
    const d = await ler();
    const pendente = d.state && (d.state_exp ?? 0) > Date.now();
    if (!code || !pendente || (state && state !== d.state)) {
      return pagina("Link expirado", "Volte ao app da Seille, abra Ajustes e toque em Conectar loja de novo.", 400);
    }
    const r = await fetch(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code", code }),
    });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) {
      return pagina("Não foi possível conectar", "A Nuvemshop não liberou o acesso. Confira o ID e o Client Secret do aplicativo nos Secrets do Supabase e tente de novo.", 400);
    }
    const novo: Dados = { store_id: Number(t.user_id), access_token: t.access_token, scope: t.scope, conectado_em: new Date().toISOString() };
    await salvar(novo);
    try { await cadastrarWebhooks(novo); } catch (e) { await salvar({ ...novo, ultimo_erro: "webhooks: " + String(e) }); }
    const voltar = d.voltar || "/";
    return new Response(null, { status: 302, headers: { Location: voltar + "#ajustes" } });
  }

  // 2) Aviso automático de pedido
  if (url.pathname.endsWith("/webhook")) {
    const corpo = await req.text();
    const sig = req.headers.get("x-linkedstore-hmac-sha256") ?? req.headers.get("http_x_linkedstore_hmac_sha256") ?? "";
    if (!(await assinaturaValida(corpo, sig))) return new Response("assinatura inválida", { status: 401 });
    let ev: any = {}; try { ev = JSON.parse(corpo); } catch { return new Response("ok"); }
    const d = await ler();
    if (!d.access_token || String(ev.store_id) !== String(d.store_id)) return new Response("ok");
    if (typeof ev.event === "string" && ev.event.startsWith("order/") && ev.id) {
      try {
        const r = await ns(d, `/orders/${ev.id}`);
        if (r.ok) {
          const ped = await r.json();
          await anexarTaxas(d, ped);
          const c = await importar([ped]);
          for (const v of c.novos) {
            // só vendas recentes: um aviso atrasado de pedido antigo não vira notificação
            if (v.pagoEm && Date.now() - new Date(v.pagoEm).getTime() > 2 * 86400_000) continue;
            try {
              await avisar(`Nova venda · ${BRL.format(v.total)}`,
                `${v.cliente || "Cliente"} · pedido #${v.pedido} · ${v.pecas} ${v.pecas === 1 ? "peça" : "peças"}`,
                "./#pedidos", "venda-" + v.id);
            } catch (e) { console.error("avisar", e); } // a venda já foi gravada; a notificação não pode travar o aviso
          }
        }
      } catch (e) { console.error(e); return new Response("erro", { status: 500 }); } // a Nuvemshop tenta de novo
    }
    return new Response("ok"); // inclui os avisos de LGPD (store/redact, customers/redact, customers/data_request)
  }

  // 3) Chamadas do app (só membros)
  if (req.method !== "POST") return json({ code: "invalid_argument" }, 405);
  const motivo = await membro(req);
  if (motivo) return json({ code: "not_granted", motivo }, 403);
  let b: any = {}; try { b = await req.json(); } catch { /* vazio */ }
  const d = await ler();
  const configurado = !!(CLIENT_ID && CLIENT_SECRET);

  if (b.acao === "status") {
    return json({ configurado, conectado: !!d.access_token, loja: d.store_id ?? null, conectadoEm: d.conectado_em ?? null, ultimaSync: d.ultima_sync ?? null, ultimoErro: d.ultimo_erro ?? null, ultimaBusca: d.ultima_busca ?? null });
  }
  if (b.acao === "conectar") {
    if (!configurado) return json({ code: "nao_configurado" }, 400);
    const voltar = typeof b.voltar === "string" && /^https:\/\/[^\s#]+$/.test(b.voltar) ? b.voltar : "";
    const state = crypto.randomUUID();
    await salvar({ ...d, state, state_exp: Date.now() + 15 * 60_000, voltar });
    return json({ url: `${AUTORIZAR}/${encodeURIComponent(CLIENT_ID)}/authorize?state=${state}` });
  }
  if (b.acao === "sincronizar") {
    if (!d.access_token) return json({ code: "nao_conectado" }, 400);
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(b.desde ?? "") ? b.desde : `${new Date().getFullYear()}-01-01`;
    try {
      const r = await sincronizar(d, desde);
      const quando = new Date().toISOString();
      await salvar({ ...d, ultima_sync: quando, ultimo_erro: undefined, ultima_busca: { quando, desde, ...r } });
      try { await cadastrarWebhooks(d); } catch { /* segue */ }
      return json({ total: r.importados, ...r });
    } catch (e) {
      console.error("sincronizar", e);
      await salvar({ ...d, ultimo_erro: String(e).slice(0, 300) });
      return json({ code: "falha", message: String(e).slice(0, 300) }, 502);
    }
  }
  if (b.acao === "push-chave") {
    const p = await chavesPush();
    return json({ publica: p.publica });
  }
  if (b.acao === "push-assinar") {
    const a = b.assinatura;
    if (!a || typeof a.endpoint !== "string" || !/^https:\/\//.test(a.endpoint) || !a.keys?.p256dh || !a.keys?.auth) return json({ code: "invalid_argument" }, 400);
    const p = await chavesPush();
    const lista = (p.assinaturas ?? []).filter((s) => s.endpoint !== a.endpoint);
    lista.push({ endpoint: a.endpoint, keys: { p256dh: String(a.keys.p256dh), auth: String(a.keys.auth) }, criadoEm: new Date().toISOString() });
    await salvarPush({ ...p, assinaturas: lista });
    return json({ ok: true, celulares: lista.length });
  }
  if (b.acao === "push-cancelar") {
    const p = await lerPush();
    await salvarPush({ ...p, assinaturas: (p.assinaturas ?? []).filter((s) => s.endpoint !== b.endpoint) });
    return json({ ok: true });
  }
  if (b.acao === "push-teste") {
    const r = await avisar("Notificações ligadas", "Você vai receber um aviso aqui a cada venda nova da loja.", "./#painel", "teste");
    return json(r);
  }
  // Abre um pedido recente no cartão e mostra onde (e se) a Nuvemshop informa taxas e juros
  if (b.acao === "diagnostico") {
    if (!d.access_token) return json({ code: "nao_conectado" }, 400);
    const r = await ns(d, `/orders?per_page=50&status=any`);
    const lista: any[] = r.ok ? await r.json() : [];
    const cartao = lista.find((o) => /credit|card/i.test(String(o.payment_details?.method ?? "")) && ["paid","authorized"].includes(o.payment_status)) ?? lista[0];
    if (!cartao) return json({ code: "sem_pedidos", status: r.status });
    const t = await lerTransacoes(d, String(cartao.id));
    const taxaT = t.lista.reduce((a: number, x: any) => a + (somaProfunda(x, RE_TAXA_T) ?? 0), 0), jurosT = t.lista.reduce((a: number, x: any) => a + (somaProfunda(x, RE_JUROS_T) ?? 0), 0);
    return json({ pedido: cartao.number, metodo: cartao.payment_details?.method ?? null, parcelas: cartao.payment_details?.installments ?? null, total: cartao.total,
      noPedido: { taxa: somaProfunda(cartao, RE_TAXA_T), juros: somaProfunda(cartao, RE_JUROS_T), campos: caminhos(cartao).slice(0, 80) },
      transacoes: { status: t.status, quantidade: t.lista.length, taxa: taxaT || null, juros: jurosT || null, campos: t.lista.flatMap((x: any) => caminhos(x)).slice(0, 80) } });
  }
  // Busca taxas e juros pelas transações, em lotes (o app chama de novo até terminar)
  if (b.acao === "taxasPedido") {
    if (!d.access_token || !b.id) return json({ code: "invalid_argument" }, 400);
    const r = await ns(d, `/orders/${encodeURIComponent(String(b.id))}`);
    if (!r.ok) return json({ code: "falha", status: r.status }, 502);
    const ped = await r.json(); await anexarTaxas(d, ped); await importar([ped]);
    return json({ taxa: ped.__taxa ?? null, juros: ped.__juros ?? null });
  }
  if (b.acao === "taxas") {
    if (!d.access_token) return json({ code: "nao_conectado" }, 400);
    const base = () => admin.from("docs").select("id,data", { count: "exact" }).eq("col", "vendas").like("id", "ns-%-0")
      .filter("data->>taxasPagas", "is", null).filter("data->>taxaBuscada", "is", null).neq("data->>status", "Cancelado");
    const { data: linhas, count } = await base().order("id").limit(80);
    let comValor = 0, processados = 0; const inicio = Date.now();
    for (const l of linhas ?? []) {
      if (Date.now() - inicio > 100_000) break;
      const v = l.data as any, t = await lerTransacoes(d, String(v.nuvemshopId));
      const taxa = t.lista.reduce((a: number, x: any) => a + (somaProfunda(x, RE_TAXA_T) ?? 0), 0), juros = t.lista.reduce((a: number, x: any) => a + (somaProfunda(x, RE_JUROS_T) ?? 0), 0);
      const novo = { ...v, taxaBuscada: true };
      if (taxa > 0 || juros > 0) { novo.taxasPagas = Math.round(taxa * 100) / 100; novo.jurosPagos = Math.round(juros * 100) / 100; comValor++; }
      await admin.from("docs").upsert({ col: "vendas", id: l.id, data: novo, updated_at: new Date().toISOString() }, { onConflict: "col,id" });
      processados++;
      if (t.status === 401 || t.status === 403 || t.status === 404 && processados === 1) { /* transações não liberadas para este app */ }
    }
    return json({ processados, comValor, restantes: Math.max(0, (count ?? 0) - processados) });
  }
  if (b.acao === "desconectar") {
    await salvar({});
    return json({ ok: true });
  }
  return json({ code: "invalid_argument" }, 400);
});
