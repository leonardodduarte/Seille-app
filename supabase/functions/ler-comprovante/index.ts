// Função "ler-comprovante": recebe o texto ou a imagem de um comprovante e pede ao Claude
// a sugestão de lançamento em JSON. A chave da API fica guardada no Supabase (secret ANTHROPIC_API_KEY),
// nunca no app. Só membros cadastrados na tabela "membros" podem usar.
import Anthropic from "npm:@anthropic-ai/sdk@1.10.0";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const TIPOS_IMAGEM = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const chaveDoJson = (nome: string) => { try { const o = JSON.parse(Deno.env.get(nome) ?? "{}"); return String(o.default ?? Object.values(o)[0] ?? ""); } catch { return ""; } };
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return resposta({ code: "invalid_argument" }, 405);

  // Confere quem está chamando
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, (Deno.env.get("SUPABASE_ANON_KEY") || chaveDoJson("SUPABASE_PUBLISHABLE_KEYS")), {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return resposta({ code: "not_granted" }, 401);
  const { data: membro } = await sb.from("membros").select("email").ilike("email", user.email ?? "").maybeSingle();
  if (!membro) return resposta({ code: "not_granted" }, 403);

  let corpo: { prompt?: unknown; images?: Array<{ media_type?: string; data?: string }> };
  try { corpo = await req.json(); } catch { return resposta({ code: "invalid_argument" }, 400); }
  const prompt = typeof corpo.prompt === "string" ? corpo.prompt : "";
  const imagens = Array.isArray(corpo.images) ? corpo.images.slice(0, 3) : [];
  if (!prompt || prompt.length > 200_000) return resposta({ code: "invalid_argument" }, 400);
  for (const im of imagens) {
    if (!TIPOS_IMAGEM.has(im.media_type ?? "") || typeof im.data !== "string" || im.data.length > 7_000_000) {
      return resposta({ code: "image_rejected" }, 400);
    }
  }

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...imagens.map((im) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: im.media_type as "image/jpeg", data: im.data! },
    })),
    { type: "text" as const, text: prompt },
  ];

  try {
    const msg = await anthropic.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      messages: [{ role: "user", content }],
    });
    if (msg.stop_reason === "refusal") return resposta({ code: "refusal" }, 422);

    const texto = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const ini = texto.indexOf("{"), fim = texto.lastIndexOf("}");
    if (ini < 0 || fim <= ini) return resposta({ code: "unavailable" }, 502);
    return resposta(JSON.parse(texto.slice(ini, fim + 1)));
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return resposta({ code: "rate_limited" }, 429);
    if (e instanceof Anthropic.APIError) {
      console.error("Erro da API do Claude", e.status, e.message);
      return resposta({ code: "unavailable" }, 502);
    }
    console.error(e);
    return resposta({ code: "unavailable" }, 500);
  }
});
