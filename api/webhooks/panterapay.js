const crypto = require('crypto');

// ⚠️ Configure isso no painel da Vercel em Settings > Environment Variables
// Nunca coloque o secret direto no código.
const WEBHOOK_SECRET = process.env.PANTERAPAY_WEBHOOK_SECRET;

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
}

async function handlePaymentFailed(payload) {
  console.log('❌ Pagamento falhou:', payload);
  // ex: await db.orders.update({ id: payload.order_id, status: 'failed' })
}

async function handleTransferApproved(payload) {
  console.log('✅ Saque aprovado:', payload);
}

async function handleTransferFailed(payload) {
  console.log('❌ Saque falhou:', payload);
}

async function handlePixInfraction(payload) {
  console.log('⚠️ Infração Pix reportada:', payload);
  // Este evento costuma exigir resposta manual/urgente — considere
  // disparar um alerta (e-mail, Slack) além de só logar.
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
