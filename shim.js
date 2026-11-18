// Camada de dados do app Seille: login, banco, arquivos e leitura com IA via Supabase.
// Expõe a mesma interface que o app usava no claude.ai: window.claude.use("db" | "assets" | "sample" | "downloads").
(() => {
  const CFG = window.SEILLE_CONFIG || {};
  const configurado = CFG.supabaseUrl && CFG.supabaseAnonKey && !/COLE_AQUI/.test(CFG.supabaseUrl + CFG.supabaseAnonKey);
  const sb = configurado ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey) : null;
  window.seilleAuth = { email: "", sair: async () => { if (sb) await sb.auth.signOut(); location.reload(); } };

  let pronto; const prontoP = new Promise(r => { pronto = r; });
  const store = {};          // col -> Map(id -> data)
  const ouvintes = {};       // col -> Set(fn)
  const ouvDoc = {};         // "col/id" -> Set(fn)
  const mapa = c => (store[c] ||= new Map());

  const snapCol = c => {
    const docs = [...mapa(c).entries()].map(([id, data]) => ({ id, exists: true, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } }));
    return { docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const snapDoc = (c, id) => { const d = mapa(c).get(id); return { id, exists: !!d, data: () => d, metadata: { fromCache: false, hasPendingWrites: false } }; };
  const avisa = c => {
    const s = snapCol(c); (ouvintes[c] || []).forEach(fn => { try { fn(s); } catch (e) { console.error(e); } });
    for (const k of Object.keys(ouvDoc)) if (k.startsWith(c + "/")) { const id = k.slice(c.length + 1); ouvDoc[k].forEach(fn => fn(snapDoc(c, id))); }
  };
  const erro = e => { console.error(e); const m = String(e?.message || e || ""); return { code: /row-level|permission|policy|JWT/i.test(m) ? "invalid_argument" : "unavailable", message: m }; };

  async function grava(c, id, data) {
    const { error } = await sb.from("docs").upsert({ col: c, id, data, updated_at: new Date().toISOString() });
    if (error) throw erro(error);
    mapa(c).set(id, data); avisa(c);
  }
  async function apaga(c, id) {
    const { error } = await sb.from("docs").delete().eq("col", c).eq("id", id);
    if (error) throw erro(error);
    mapa(c).delete(id); avisa(c);
  }
  const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "").slice(0, 20);

  function docRef(c, id) {
    return {
      id, path: c + "/" + id,
      get: async () => { await prontoP; return snapDoc(c, id); },
      set: data => grava(c, id, JSON.parse(JSON.stringify(data))),
      update: data => grava(c, id, { ...(mapa(c).get(id) || {}), ...JSON.parse(JSON.stringify(data)) }),
      delete: () => apaga(c, id),
      onSnapshot(next) {
        const k = c + "/" + id; (ouvDoc[k] ||= new Set()).add(next);
        prontoP.then(() => next(snapDoc(c, id)));
        return () => ouvDoc[k].delete(next);
      },
    };
  }
  const db = {
    collection(c) {
      return {
        path: c,
        doc: id => docRef(c, id || novoId()),
        add: async data => { const id = novoId(); await grava(c, id, JSON.parse(JSON.stringify(data))); return docRef(c, id); },
        get: async () => { await prontoP; return snapCol(c); },
        onSnapshot(next) { (ouvintes[c] ||= new Set()).add(next); prontoP.then(() => next(snapCol(c))); return () => ouvintes[c].delete(next); },
      };
    },
    doc(path) { const [c, id] = path.split("/"); return docRef(c, id); },
  };

  const assets = {
    async upload(file) {
      const nome = (file.name || "arquivo").normalize("NFD").replace(/[^\w.-]+/g, "_").slice(-60);
      const path = novoId() + "-" + nome;
      const { error } = await sb.storage.from("comprovantes").upload(path, file, { contentType: file.type || "application/octet-stream" });
      if (error) throw erro(error);
      return { id: path, url: null, sizeBytes: file.size, contentType: file.type };
    },
    async delete(id) { await sb.storage.from("comprovantes").remove([id]); },
    async baixar(id) { const { data, error } = await sb.storage.from("comprovantes").download(id); if (error) throw erro(error); return data; },
  };
  // Abre um comprovante guardado (links com data-blob)
  document.addEventListener("click", async e => {
    const a = e.target.closest?.("[data-blob]"); if (!a || !sb) return;
    e.preventDefault(); e.stopPropagation();
    const w = window.open("", "_blank");
    const { data, error } = await sb.storage.from("comprovantes").createSignedUrl(a.dataset.blob, 600);
    if (error || !data) { if (w) w.close(); alert("Não foi possível abrir o arquivo."); return; }
    if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
  }, true);

  const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
  const sample = Object.assign(async () => { throw { code: "unavailable" }; }, {
    limits: async () => ({ images: { maxCount: 3, mediaTypes: ["image/jpeg", "image/png", "image/webp"] } }),
    async json(prompt, opts = {}) {
      const images = [];
      for (const im of [].concat(opts.images || [])) images.push({ media_type: im.type || "image/jpeg", data: await b64(im) });
      const { data, error } = await sb.functions.invoke("ler-comprovante", { body: { prompt, images } });
      if (error) { let code = "unavailable"; try { const j = await error.context.json(); code = j.code || code; } catch {} throw { code, message: String(error.message || error) }; }
      return data;
    },
  });
  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(new Blob([data], { type: /\.csv$/i.test(filename) ? "text/csv" : "application/octet-stream" }));
      const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
  };

  // Ligação com a Nuvemshop (função "nuvemshop" no Supabase)
  window.seilleNuvem = {
    async chamar(acao, extra = {}) {
      if (!sb) throw { code: "unavailable" };
      const { data, error } = await sb.functions.invoke("nuvemshop", { body: { acao, ...extra } });
      if (error) { let j = {}; try { j = await error.context.json(); } catch {} throw { code: j.code || (error.context?.status === 404 ? "sem_funcao" : "unavailable"), motivo: j.motivo, status: error.context?.status, message: j.message || String(error.message || error) }; }
      return data;
    },
  };

  // Chamada genérica às funções do Supabase (ex.: "planilha")
  window.seilleFuncao = async (nome, acao, extra = {}) => {
    if (!sb) throw { code: "unavailable" };
    const { data, error } = await sb.functions.invoke(nome, { body: { acao, ...extra } });
    if (error) { let j = {}; try { j = await error.context.json(); } catch {} const semResposta = !error.context || error.name === "FunctionsFetchError"; throw { ...j, code: j.code || (semResposta ? "sem_conexao" : error.context?.status === 404 ? "sem_funcao" : "unavailable"), status: error.context?.status, message: j.erro || j.message || String(error.message || error) }; }
    return data;
  };

  const CAPS = { db, assets, sample, downloads };
  window.claude = { use: async nome => { if (!sb) return null; await prontoP; return CAPS[nome] ?? null; } };

  // ---------- carga inicial + tempo real ----------
  async function carregar() {
    for (let de = 0; ; de += 1000) {
      const { data, error } = await sb.from("docs").select("col,id,data").range(de, de + 999);
      if (error) throw error;
      data.forEach(r => mapa(r.col).set(r.id, r.data));
      if (data.length < 1000) break;
    }
    sb.channel("docs").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => {
      if (p.eventType === "DELETE") { const o = p.old || {}; if (o.col && o.id) { mapa(o.col).delete(o.id); avisa(o.col); } }
      else { const n = p.new; mapa(n.col).set(n.id, n.data); avisa(n.col); }
    }).subscribe();
    pronto();
  }

  // ---------- tela de login ----------
  function telaLogin(msg) {
    const el = document.getElementById("login");
    el.hidden = false;
    el.innerHTML = `<form class="modal" id="lf" style="max-width:380px">
      <img src="icons/icon-192.png?v=2" alt="Seille" class="llogo">
      ${configurado ? `<p class="sub" style="margin:0">Entre com o e-mail e a senha cadastrados.</p>
      <div class="f"><label for="le">E-mail</label><input id="le" type="email" autocomplete="username" required></div>
      <div class="f"><label for="ls">Senha</label><input id="ls" type="password" autocomplete="current-password" required></div>
      <div class="err" id="lerr" ${msg ? "" : "hidden"}>${msg || ""}</div>
      <button class="btn pri" type="submit">Entrar</button>`
      : `<div class="banner warn">O app ainda não foi conectado ao banco de dados. Preencha o arquivo config.js com o endereço e a chave pública do Supabase (veja o LEIAME).</div>`}
    </form>`;
    const f = document.getElementById("lf");
    f.addEventListener("submit", async e => {
      e.preventDefault();
      const btn = f.querySelector("button"); btn.disabled = true; btn.textContent = "Entrando…";
      const { error } = await sb.auth.signInWithPassword({ email: f.le.value.trim(), password: f.ls.value });
      if (error) { const er = document.getElementById("lerr"); er.hidden = false; er.textContent = "E-mail ou senha incorretos."; btn.disabled = false; btn.textContent = "Entrar"; return; }
      location.reload();
    });
  }

  (async () => {
    if (document.readyState === "loading") await new Promise(r => document.addEventListener("DOMContentLoaded", r));
    if (!sb) { telaLogin(); return; }
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { telaLogin(); return; }
    window.seilleAuth.email = session.user.email;
    try { await carregar(); }
    catch (e) { console.error(e); telaLogin("Sua conta não tem acesso aos dados da Seille. Peça para incluir seu e-mail na lista de membros."); await sb.auth.signOut(); }
  })();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
