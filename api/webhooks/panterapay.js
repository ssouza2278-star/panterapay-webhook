const crypto = require('crypto');
const https = require('https');

// ⚠️ Configure isso no painel da Vercel em Settings > Environment Variables
// Nunca coloque o secret direto no código.
const WEBHOOK_SECRET = process.env.PANTERAPAY_WEBHOOK_SECRET;

// --- Configuração do WhatsApp via Twilio ---
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // ex: whatsapp:+14155238886
const MY_WHATSAPP_NUMBER = process.env.MY_WHATSAPP_NUMBER; // ex: whatsapp:+5511949867547

// URL pública da logo da PanteraPay (hospedada neste mesmo projeto, pasta /public)
// process.env.VERCEL_URL já vem preenchido automaticamente pela Vercel em runtime.
const LOGO_URL = `https://${process.env.VERCEL_URL || 'SEU-DOMINIO.vercel.app'}/panterapay-logo.jpg`;

// Envia uma mensagem de WhatsApp com a logo anexada, via API da Twilio
async function sendWhatsAppNotification(text) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !MY_WHATSAPP_NUMBER) {
    console.warn('⚠️ Variáveis da Twilio não configuradas — notificação de WhatsApp pulada.');
    return;
  }

  // 📷 Envio de logo temporariamente desativado — estava dando erro de
  // carregamento da imagem. Removido MediaUrl para garantir que o TEXTO
  // da notificação chegue de forma confiável. Para reativar a logo depois,
  // volte a incluir MediaUrl: LOGO_URL no objeto abaixo, uma vez que a
  // URL da imagem estiver funcionando corretamente.
  const body = new URLSearchParams({
    From: TWILIO_WHATSAPP_FROM,
    To: MY_WHATSAPP_NUMBER,
    Body: text,
  }).toString();

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Basic ${auth}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log('✅ Notificação WhatsApp enviada.');
          } else {
            console.error('❌ Falha ao enviar WhatsApp:', res.statusCode, data);
          }
          resolve(data); // não derruba o webhook por causa de falha no WhatsApp
        });
      }
    );
    req.on('error', (err) => {
      console.error('❌ Erro de rede ao enviar WhatsApp:', err);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  // A PanteraPay só aceita POST — qualquer outro método, rejeita.
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // --- 1. Captura o corpo bruto da requisição ---
  // A validação de assinatura precisa do body EXATO como foi enviado
  // (não do JSON já parseado), senão o hash não bate.
  const rawBody = await getRawBody(req);

  // --- 2. Valida a assinatura ---
  // ATENÇÃO: ajuste o nome do header conforme a documentação da PanteraPay.
  // Nomes comuns usados por gateways: 'x-panterapay-signature',
  // 'x-signature', 'x-webhook-secret'. Confirme na aba "Documentação".
  const signatureHeader = req.headers['x-panterapay-signature'];

  // 🔧 MODO BOOTSTRAP: enquanto PANTERAPAY_WEBHOOK_SECRET não estiver
  // configurado na Vercel, aceitamos a requisição sem validar assinatura.
  // Isso é necessário porque a PanteraPay testa a URL ANTES de gerar o
  // secret, e sem isso o teste inicial nunca passaria.
  // ⚠️ IMPORTANTE: assim que você tiver o secret e configurá-lo na Vercel,
  // REMOVA este bloco "if (!WEBHOOK_SECRET)" para voltar à validação
  // estrita — deixar isso em produção sem o secret configurado significa
  // que QUALQUER UM poderia enviar notificações falsas para este endpoint.
  if (!WEBHOOK_SECRET) {
    console.warn('⚠️ Rodando em modo bootstrap: PANTERAPAY_WEBHOOK_SECRET ainda não configurado. Validação de assinatura DESATIVADA.');
  } else {
    if (!signatureHeader) {
      return res.status(401).json({ error: 'Assinatura ausente' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');

    const isValid = safeCompare(signatureHeader, expectedSignature);

    if (!isValid) {
      console.warn('Assinatura inválida recebida em webhook PanteraPay.');
      return res.status(401).json({ error: 'Assinatura inválida' });
    }
  }

  // --- 3. Parseia o payload já validado ---
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'JSON inválido' });
  }

  // Ajuste o nome do campo conforme o payload real da PanteraPay
  // (pode vir como "event", "type", "event_type" etc.)
  const eventType = payload.event || payload.type;

  console.log(`Webhook PanteraPay recebido: ${eventType}`);

  // --- 4. Trata cada evento ---
  try {
    switch (eventType) {
      case 'payment.approved':
        await handlePaymentApproved(payload);
        break;

      case 'payment.failed':
        await handlePaymentFailed(payload);
        break;

      case 'transfer-approved':
        await handleTransferApproved(payload);
        break;

      case 'transfer-failed':
        await handleTransferFailed(payload);
        break;

      case 'pix.infraction':
        await handlePixInfraction(payload);
        break;

      default:
        console.warn(`Evento desconhecido recebido: ${eventType}`);
    }
  } catch (err) {
    // Se o processamento falhar, responda 500 para a PanteraPay
    // tentar reenviar depois. Não deixe erro interno virar um 200 falso.
    console.error('Erro ao processar webhook:', err);
    return res.status(500).json({ error: 'Erro interno ao processar evento' });
  }

  // --- 5. Confirma recebimento rapidamente ---
  // Gateways costumam re-tentar se não receberem 200 em poucos segundos.
  return res.status(200).json({ received: true });
};

// ---------- Handlers de cada evento ----------
// Substitua os console.log pela sua lógica real:
// atualizar pedido no banco, liberar produto, notificar o cliente, etc.

async function handlePaymentApproved(payload) {
  console.log('✅ Pagamento aprovado:', payload);
  // ex: await db.orders.update({ id: payload.order_id, status: 'paid' })
  await sendWhatsAppNotification(
    `✅ *PanteraPay* — Venda aprovada!\nValor: ${formatAmount(payload.amount)}\nID: ${payload.order_id || payload.id || 'N/A'}`
  );
}

async function handlePaymentFailed(payload) {
  console.log('❌ Pagamento falhou:', payload);
  // ex: await db.orders.update({ id: payload.order_id, status: 'failed' })
  await sendWhatsAppNotification(
    `❌ *PanteraPay* — Venda não concluída.\nValor: ${formatAmount(payload.amount)}\nID: ${payload.order_id || payload.id || 'N/A'}`
  );
}

async function handleTransferApproved(payload) {
  console.log('✅ Saque aprovado:', payload);
  await sendWhatsAppNotification(
    `✅ *PanteraPay* — Saque realizado!\nValor: ${formatAmount(payload.amount)}\nID: ${payload.id || 'N/A'}`
  );
}

async function handleTransferFailed(payload) {
  console.log('❌ Saque falhou:', payload);
  await sendWhatsAppNotification(
    `❌ *PanteraPay* — Saque falhou.\nValor: ${formatAmount(payload.amount)}\nID: ${payload.id || 'N/A'}`
  );
}

async function handlePixInfraction(payload) {
  console.log('⚠️ Infração Pix reportada:', payload);
  // Este evento costuma exigir resposta manual/urgente — considere
  // disparar um alerta (e-mail, Slack) além de só logar.
  await sendWhatsAppNotification(
    `⚠️ *PanteraPay* — Infração Pix reportada. Verifique o painel com urgência.\nID: ${payload.id || 'N/A'}`
  );
}

// Formata centavos como Real brasileiro (ex: 1490 -> R$ 14,90)
function formatAmount(cents) {
  if (typeof cents !== 'number') return 'N/A';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ---------- Utilitários ----------

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Comparação em tempo constante, evita timing attacks na validação da assinatura
function safeCompare(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Necessário na Vercel para termos acesso ao stream bruto do body
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
