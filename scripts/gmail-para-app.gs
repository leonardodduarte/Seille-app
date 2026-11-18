/**
 * Seille Gestão — envia ao app os PDFs que chegam no e-mail de contas (boletos, DARF, comprovantes, holerites).
 * Roda dentro da conta do Gmail (script.google.com), de hora em hora. Só LÊ os e-mails; marca os já enviados
 * com o marcador "seille-app" para não mandar de novo. Nada é lançado no app sem a sua confirmação.
 *
 * Configuração (uma vez):
 *  1. Em "Configurações do projeto" (engrenagem) → "Propriedades do script", crie:
 *       SEILLE_TOKEN = a mesma senha cadastrada no Supabase como EMAIL_TOKEN
 *  2. Selecione a função "instalar" e toque em "Executar". Autorize o acesso pedido pelo Google.
 */
const SEILLE_URL = "https://bbpwibqysasqopiqelvd.supabase.co/functions/v1/email-docs";
const MARCADOR = "seille-app";
const DESDE = "2025/12/01"; // e-mails a partir desta data (a primeira busca traz o histórico aos poucos)
// Por enquanto só as guias do Simples Nacional (DAS). Para voltar a receber todos os PDFs, deixe FILTRO = "".
const FILTRO = '("simples nacional" OR DAS OR PGDAS OR "documento de arrecadação")';

function buscarDocumentos() {
  const token = PropertiesService.getScriptProperties().getProperty("SEILLE_TOKEN");
  if (!token) throw new Error("Falta a propriedade SEILLE_TOKEN (Configurações do projeto → Propriedades do script).");
  const marcador = GmailApp.getUserLabelByName(MARCADOR) || GmailApp.createLabel(MARCADOR);
  const inicio = Date.now();
  const conversas = GmailApp.search(`has:attachment filename:pdf after:${DESDE} ${FILTRO} -label:${MARCADOR}`, 0, 40);
  let enviados = 0;
  for (const conversa of conversas) {
    if (Date.now() - inicio > 4.5 * 60 * 1000) break; // o Google limita cada execução a 6 minutos
    let tudoCerto = true;
    for (const msg of conversa.getMessages()) {
      for (const anexo of msg.getAttachments({ includeInlineImages: false })) {
        const nome = anexo.getName() || "documento.pdf";
        if (!/\.pdf$/i.test(nome) && anexo.getContentType() !== "application/pdf") continue;
        if (anexo.getSize() > 15 * 1024 * 1024) continue;
        const resp = UrlFetchApp.fetch(SEILLE_URL, {
          method: "post", contentType: "application/json", muteHttpExceptions: true,
          headers: { "x-seille-token": token },
          payload: JSON.stringify({
            mensagemId: msg.getId(), nome, tipo: "application/pdf",
            de: msg.getFrom(), assunto: msg.getSubject(), data: msg.getDate().toISOString(),
            base64: Utilities.base64Encode(anexo.getBytes()),
          }),
        });
        if (resp.getResponseCode() >= 300) { tudoCerto = false; console.warn(nome, resp.getResponseCode(), resp.getContentText()); }
        else enviados++;
      }
    }
    if (tudoCerto) conversa.addLabel(marcador); // se algo falhar, tenta de novo na próxima hora
  }
  console.log(`${enviados} PDF(s) enviados ao app.`);
}

function instalar() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === "buscarDocumentos").forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("buscarDocumentos").timeBased().everyHours(1).create();
  buscarDocumentos();
}
