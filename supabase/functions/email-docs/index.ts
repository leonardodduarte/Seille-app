// Função "email-docs": recebe os PDFs que chegam no e-mail de contas da Seille (enviados por um Google Apps Script
// que roda na própria conta do Gmail) e guarda numa caixa de entrada do app, para conferir e lançar na aba
// "Adicionar documentos". Não lança nada sozinha.
//
// Segredo (Supabase → Edge Functions → Secrets):
//  EMAIL_TOKEN   uma senha longa inventada por vocês; a mesma vai no Apps Script (Propriedades do script).
// Publicada sem "Verify JWT": quem chama é o Google, e a senha acima é conferida aqui.
import { createClient } from "npm:@supabase/supabase-js@2";

const chaveDoJson = (nome: string) => { try { const o = JSON.parse(Deno.env.get(nome) ?? "{}"); return String(o.default ?? Object.values(o)[0] ?? ""); } catch { return ""; } };
const admin = createClient(Deno.env.get("SUPABASE_URL")!, chaveDoJson("SUPABASE_SECRET_KEYS") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { auth: { persistSession: false, autoRefreshToken: false } });
const TOKEN = (Deno.env.get("EMAIL_TOKEN") ?? "").trim();
const LIMITE = 15 * 1024 * 1024; // 15 MB por arquivo

const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });

function iguais(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function sha(txt: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
const limpaNome = (s: string) => (s || "documento.pdf").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_").slice(-80);

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  if (!TOKEN) return json({ erro: "Falta o segredo EMAIL_TOKEN no Supabase." }, 503);
  if (!iguais(req.headers.get("x-seille-token") ?? "", TOKEN)) return json({ erro: "senha inválida" }, 401);

  let b: any; try { b = await req.json(); } catch { return json({ erro: "corpo inválido" }, 400); }
  const nome = String(b.nome ?? "documento.pdf"), base64 = String(b.base64 ?? "");
  if (!/\.pdf$/i.test(nome) && b.tipo !== "application/pdf") return json({ ignorado: "não é PDF" });
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)); } catch { return json({ erro: "arquivo inválido" }, 400); }
  if (!bytes.length || bytes.length > LIMITE) return json({ erro: "arquivo vazio ou grande demais" }, 400);

  // o mesmo anexo do mesmo e-mail nunca entra duas vezes
  const id = "em-" + await sha(`${b.mensagemId ?? ""}|${nome}|${bytes.length}`);
  const { data: existe } = await admin.from("docs").select("id").eq("col", "entrada").eq("id", id).maybeSingle();
  if (existe) return json({ ok: true, repetido: true, id });

  const caminho = `email/${id}-${limpaNome(nome)}`;
  const up = await admin.storage.from("comprovantes").upload(caminho, bytes, { contentType: "application/pdf", upsert: true });
  if (up.error) return json({ erro: "não foi possível guardar o arquivo: " + up.error.message }, 500);

  const agora = new Date().toISOString();
  const { error } = await admin.from("docs").upsert({
    col: "entrada", id, updated_at: agora,
    data: {
      arquivo: caminho, nome, tamanho: bytes.length, status: "novo",
      de: String(b.de ?? "").slice(0, 200), assunto: String(b.assunto ?? "").slice(0, 300),
      recebidoEm: /^\d{4}-\d{2}-\d{2}T/.test(String(b.data ?? "")) ? b.data : agora, criadoEm: agora,
    },
  }, { onConflict: "col,id" });
  if (error) return json({ erro: error.message }, 500);
  return json({ ok: true, id });
});
