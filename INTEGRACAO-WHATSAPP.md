# Confirmações automáticas — André Nascimento

## O que está implementado na branch
- O site envia solicitações reais para \`POST /api/bookings\` (sem mexer no portfólio).
- O horário é reservado provisoriamente; o painel em \`/admin.html\` permite aprovar ou cancelar.
- Após aprovação, agenda-se lembrete **duas horas antes** da avaliação, no horário do Acre (UTC-4).
- Um daemon persistente executa Baileys e verifica a fila a cada 30 segundos.
- O texto pede que o cliente responda **1 para confirmar** ou **2 para avisar que não poderá comparecer**; a resposta aparece no painel.
- A autenticação do WhatsApp é criptografada com AES-256-GCM e armazenada em Redis.
- Os envios reais são desativados por padrão.

## Infraestrutura obrigatória
1. Vincular o repositório \`tatoo\` a um **projeto Vercel com Root Directory na raiz**. Vercel Daemons não funciona com Root Directory configurado em uma subpasta.
2. Criar um Redis compatível com **Upstash REST**, preferencialmente via integração de Storage/Marketplace na Vercel.
3. Configurar variáveis de ambiente de **Production** no projeto Vercel:
   - \`UPSTASH_REDIS_REST_URL\`
   - \`UPSTASH_REDIS_REST_TOKEN\`
   - \`TATTOO_ADMIN_TOKEN\`: chave aleatória de pelo menos 32 caracteres.
   - \`WA_AUTH_ENCRYPTION_KEY\`: 32 bytes aleatórios codificados em base64.
   - \`WHATSAPP_CONNECT_ENABLED=0\` (alterar para \`1\` ao conectar via QR Code).
   - \`WHATSAPP_SEND_ENABLED=0\` (alterar para \`1\` somente depois de testes).
4. Publicar em **Production** (Daemons não executam em Preview).
5. Acessar \`/admin.html\` com \`TATTOO_ADMIN_TOKEN\`. Quando a conexão estiver ativa, escanear o QR Code.
6. Criar agendamento de teste, aprovar no painel, verificar se aparece na fila e, somente depois, habilitar os disparos.

## Observações e riscos
- WhatsApp Baileys é uma integração **não oficial**, sem garantia de disponibilidade ou ausência de bloqueios.
- É necessário vincular inicialmente o WhatsApp com QR Code; o telefone não precisa atuar como servidor 24h.
- Daemons usam armazenamento local **efêmero**; Redis é necessário para persistência e recuperação.
- O fluxo não envia automaticamente a cliente algum quando o tatuador apenas recebe uma solicitação não aprovada.
- Em falhas entre envio de mensagem e persistência da marcação, ainda existe risco de repetição; exige teste controlado antes de uso comercial.
- O horário do estúdio foi configurado para Acre (UTC-4); alterar se o estúdio operar em outra região.
- O aviso de privacidade/consentimento da página pública precisa ser revisado antes da entrada em produção.
- O projeto \`tatoo-adm\` estava vazio; o painel desta implementação está no mesmo projeto \`tatoo\`.
- A chave de administrador não deve ser publicada, compartilhada em logs, ou colocada no frontend.
