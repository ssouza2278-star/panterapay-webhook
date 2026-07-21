# Webhook PanteraPay

Endpoint serverless (Vercel) para receber notificações de vendas/saques da PanteraPay.

## 1. Deploy na Vercel (gera sua URL pública)

**Opção A — pelo site (mais simples, sem terminal):**
1. Crie uma conta em https://vercel.com (pode entrar com GitHub)
2. Suba esta pasta para um repositório no GitHub (pode arrastar os arquivos direto na interface do GitHub, criando um repo novo)
3. Na Vercel, clique em "Add New" → "Project" → selecione o repositório
4. Clique em "Deploy" (não precisa mudar nenhuma configuração)

**Opção B — pelo terminal:**
```bash
npm install -g vercel
cd panterapay-webhook
vercel login
vercel --prod
```

Ao final, a Vercel te dá uma URL do tipo:
```
https://panterapay-webhook-seunome.vercel.app
```

Sua URL de webhook completa será:
```
https://panterapay-webhook-seunome.vercel.app/api/webhooks/panterapay
```

É essa URL completa (terminando em `/api/webhooks/panterapay`) que você cola no campo "Endpoint" da PanteraPay — não a URL raiz.

## 2. Configurar o secret

1. No painel da Vercel: **Settings → Environment Variables**
2. Adicione:
   - Nome: `PANTERAPAY_WEBHOOK_SECRET`
   - Valor: o secret/token que a PanteraPay te forneceu (veja na aba "Credenciais" ou "Documentação" do painel deles)
3. Redeploy o projeto (Settings → Deployments → ⋯ → Redeploy) para a variável valer

## 3. Ajustar conforme a documentação real da PanteraPay

Antes de ativar de verdade, confira na aba **"Documentação"** do painel da PanteraPay (que aparece na sua screenshot) estes 3 detalhes e ajuste no arquivo `api/webhooks/panterapay.js`:

| O que confirmar | Onde ajustar no código |
|---|---|
| Nome exato do header de assinatura (ex: `x-panterapay-signature`) | linha com `req.headers['x-panterapay-signature']` |
| Algoritmo de assinatura (HMAC-SHA256 é o mais comum, mas confirme) | `crypto.createHmac('sha256', ...)` |
| Nome do campo que identifica o tipo de evento no payload (`event`, `type`, etc.) | `payload.event \|\| payload.type` |

## 4. Testar

A PanteraPay diz que valida a URL com um POST de teste antes de salvar — é só colar a URL final no campo "Endpoint" da tela de Webhooks e ela testa sozinha.

Para testar manualmente antes disso, você pode usar `curl`:
```bash
curl -X POST https://sua-url.vercel.app/api/webhooks/panterapay \
  -H "Content-Type: application/json" \
  -H "x-panterapay-signature: assinatura_de_teste" \
  -d '{"event":"payment.approved","order_id":"123"}'
```
(vai retornar 401 se a assinatura não bater — o que é esperado, já que é um teste manual sem o secret real)

## 5. Onde colocar sua lógica de negócio

Dentro de `api/webhooks/panterapay.js`, cada evento tem uma função própria (`handlePaymentApproved`, `handlePaymentFailed`, etc.) — é ali que você coloca o código para atualizar seu pedido, liberar acesso ao produto, notificar o cliente, etc.
