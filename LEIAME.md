# Seille Gestão — app próprio

App de gestão da Seille: pedidos sob demanda, ficha técnica das peças, custos, funcionárias, coleções, tráfego pago e leitura de comprovantes com IA. Ele roda no navegador e se instala na tela inicial do celular como um aplicativo.

**Onde cada coisa fica**

| Parte | Serviço | Custo |
|---|---|---|
| Telas do app | GitHub Pages | grátis |
| Login, banco de dados e comprovantes | Supabase | grátis até 500 MB de dados e 1 GB de arquivos |
| Leitura de comprovantes | API do Claude (Anthropic) | alguns centavos por documento |

---

## 1. Banco de dados (Supabase)

1. Entre em **supabase.com** → **Start your project** → entre com o GitHub.
2. **New project**: nome `seille`, crie uma senha forte para o banco (guarde-a) e escolha a região **South America (São Paulo)**.
3. Quando o projeto terminar de criar, abra **SQL Editor** → **New query**.
4. Copie todo o conteúdo do arquivo `supabase/schema.sql`. **Antes de rodar, troque os dois e-mails do final** pelos e-mails de vocês dois. Clique em **Run**.
5. Vá em **Authentication** → **Users** → **Add user** → **Create new user**. Crie um usuário para cada um de vocês, com o mesmo e-mail do passo anterior e uma senha, e marque **Auto Confirm User**.
6. Vá em **Project Settings** → **API** e copie:
   - **Project URL** (ex.: `https://abcdefgh.supabase.co`)
   - a chave **anon public**

   Cole os dois no arquivo `config.js`. A chave *anon* é pública por natureza: quem protege os dados é o login e as regras do banco. **Nunca** coloque a chave *service_role* no app.

## 2. Leitura de comprovantes com IA

1. Entre em **console.anthropic.com**, crie a conta e adicione créditos em **Billing** (US$ 5 dão para centenas de comprovantes).
2. Em **API Keys**, crie uma chave e copie.
3. No Supabase: **Edge Functions** → **Secrets** → **Add new secret**. Nome `ANTHROPIC_API_KEY`, valor: a chave copiada.
4. **Edge Functions** → **Deploy a new function** → **Via Editor**. Nome: `ler-comprovante`. Apague o exemplo, cole o conteúdo de `supabase/functions/ler-comprovante/index.ts` e clique em **Deploy**.

Sem este passo o app funciona normalmente; só a aba **Ler comprovantes** fica indisponível.

## 3. Publicar o app (GitHub Pages)

1. No repositório do GitHub: **Settings** → **Pages**.
2. Em **Build and deployment**, escolha **Deploy from a branch**, branch **main**, pasta **/ (root)** → **Save**.
3. Depois de um a dois minutos, o app fica em `https://SEU-USUARIO.github.io/seille-app/`.

## 4. Instalar no celular

Abra o endereço do app no celular e entre com e-mail e senha.

- **iPhone (Safari):** botão Compartilhar → **Adicionar à Tela de Início** → Adicionar.
- **Android (Chrome):** menu ⋮ → **Instalar app** (ou **Adicionar à tela inicial**).

O ícone **Seille** aparece com os outros aplicativos e abre em tela cheia, sem a barra do navegador.

---

## Para incluir outra pessoa

1. Supabase → **SQL Editor**: `insert into public.membros (email) values ('novo@email.com');`
2. **Authentication** → **Users** → **Add user** com o mesmo e-mail.

## Backup

No Supabase, **Database** → **Backups** mostra os backups diários automáticos do plano. No app, **Ajustes** → **Baixar pedidos do mês** gera uma planilha CSV.

## Estrutura dos arquivos

- `index.html` — telas e cálculos do app
- `shim.js` — login e conexão com o banco, arquivos e IA
- `config.js` — endereço e chave pública do Supabase
- `manifest.webmanifest`, `sw.js`, `icons/` — instalação como aplicativo
- `supabase/schema.sql` — criação do banco e das regras de acesso
- `supabase/functions/ler-comprovante/index.ts` — função que chama o Claude
- `vendor/` — bibliotecas usadas pelo app (Supabase e leitor de PDF)
