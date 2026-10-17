import makeWASocket, { BufferJSON, DisconnectReason, initAuthCreds, proto } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import crypto from 'node:crypto';

const PREFIX = 'tatuador:v1:';
const key = (s) => PREFIX + s;
const storeUrl = process.env.UPSTASH_REDIS_REST_URL;
const storeToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const cipherKey = Buffer.from(process.env.WA_AUTH_ENCRYPTION_KEY || '', 'base64');
const connectEnabled = process.env.WHATSAPP_CONNECT_ENABLED === '1';
const sendEnabled = process.env.WHATSAPP_SEND_ENABLED === '1';
let stopping = false;
let socket = null;
let ready = false;
let timer = null;
let rejoinTimer = null;
let active = false;

async function redis(...args) {
  if (!storeUrl || !storeToken) throw new Error('Redis não configurado');
  const response = await fetch(storeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + storeToken },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('Redis indisponível: HTTP ' + response.status);
  const value = await response.json();
  if (value.error) throw new Error('Redis indisponível');
  return value.result;
}
async function status(state, extra = {}) {
  try { await redis('SET', key('wa:status'), JSON.stringify({ state, at: new Date().toISOString(), ...extra }), 'EX', 180); }
  catch (error) { console.error('Erro ao atualizar status:', error.message); }
}
function seal(data) {
  if (cipherKey.length !== 32) throw new Error('WA_AUTH_ENCRYPTION_KEY deve ter 32 bytes em base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data, BufferJSON.replacer), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
function unseal(value) {
  const buffer = Buffer.from(value, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext, BufferJSON.reviver);
}
async function authState() {
  const saved = await redis('GET', key('wa:auth:creds'));
  const creds = saved ? unseal(saved) : initAuthCreds();
  const keys = {
    get: async (type, ids) => {
      const result = {};
      for (const id of ids) {
        const value = await redis('GET', key('wa:auth:' + type + ':' + id));
        if (value) {
          let data = unseal(value);
          if (type === 'app-state-sync-key') data = proto.Message.AppStateSyncKeyData.fromObject(data);
          result[id] = data;
        }
      }
      return result;
    },
    set: async (data) => {
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          const item = data[type][id];
          const path = key('wa:auth:' + type + ':' + id);
          if (item === null || item === undefined) await redis('DEL', path);
          else await redis('SET', path, seal(item));
        }
      }
    }
  };
  return { state: { creds, keys }, saveCreds: () => redis('SET', key('wa:auth:creds'), seal(creds)) };
}
function messageText(m) {
  const body = m.message || {};
  return String(body.conversation || body.extendedTextMessage?.text || body.ephemeralMessage?.message?.extendedTextMessage?.text || '').trim().toLowerCase();
}
async function onMessages(payload) {
  if (payload.type !== 'notify') return;
  for (const m of payload.messages || []) {
    if (m.key?.fromMe) continue;
    const jid = m.key?.remoteJid || '';
    if (!jid.endsWith('@s.whatsapp.net')) continue;
    const text = messageText(m);
    if (!/^(1|2|sim|não|nao|confirmo|cancelar|confirmado)$/.test(text)) continue;
    const phone = jid.split('@')[0];
    const id = await redis('GET', key('wa:reply:' + phone));
    if (!id) continue;
    const raw = await redis('GET', key('booking:' + id));
    if (!raw) continue;
    const booking = JSON.parse(raw);
    if (booking.status !== 'reminder_sent') continue;
    if (['1', 'sim', 'confirmo', 'confirmado'].includes(text)) booking.status = 'client_confirmed';
    else booking.status = 'client_cancelled';
    booking.respondedAt = new Date().toISOString();
    await redis('SET', key('booking:' + id), JSON.stringify(booking), 'EX', 15552000);
    await redis('DEL', key('wa:reply:' + phone));
    // Cancelamento solicitado pelo cliente requer gestão humana; não libera o horário automaticamente.
  }
}
function formattedDate(date) {
  const [year, month, day] = date.split('-');
  return day + '/' + month + '/' + year;
}
async function processDue() {
  if (!ready || !sendEnabled || stopping || active || !socket) return;
  active = true;
  try {
    const due = await redis('ZRANGEBYSCORE', key('reminders'), '-inf', Date.now(), 'LIMIT', 0, 1);
    for (const id of due || []) {
      const lock = key('wa:claim:' + id);
      if (await redis('SET', lock, '1', 'EX', 180, 'NX') !== 'OK') continue;
      try {
        const raw = await redis('GET', key('booking:' + id));
        if (!raw) { await redis('ZREM', key('reminders'), id); continue; }
        const booking = JSON.parse(raw);
        if (booking.status !== 'confirmed' || Date.parse(booking.appointmentAt) <= Date.now()) {
          await redis('ZREM', key('reminders'), id); continue;
        }
        const firstName = booking.name.split(' ')[0];
        const body = 'Olá, ' + firstName + '! Passando para confirmar sua avaliação com André, no dia ' +
          formattedDate(booking.date) + ', às ' + booking.time + '. Tudo confirmado?\n\n' +
          'Responda 1 para CONFIRMAR ou 2 se NÃO puder comparecer.';
        await socket.sendMessage(booking.phone + '@s.whatsapp.net', { text: body });
        booking.status = 'reminder_sent';
        booking.reminderSentAt = new Date().toISOString();
        await redis('SET', key('booking:' + id), JSON.stringify(booking), 'EX', 15552000);
        await redis('SET', key('wa:reply:' + booking.phone), id, 'EX', 172800);
        await redis('ZREM', key('reminders'), id);
      } catch (error) {
        console.error('Erro no envio:', id, error.message);
      } finally {
        await redis('DEL', lock).catch(() => {});
      }
    }
  } catch (error) { console.error('Falha da fila:', error.message); }
  finally { active = false; }
}
async function connect() {
  if (stopping) return;
  try {
    const { state, saveCreds } = await authState();
    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['André Tatuador', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });
    socket = sock;
    sock.ev.on('creds.update', () => { saveCreds().catch(error => console.error('Credenciais:', error.message)); });
    sock.ev.on('messages.upsert', payload => { onMessages(payload).catch(error => console.error('Respostas:', error.message)); });
    sock.ev.on('connection.update', async update => {
      if (update.qr) {
        await redis('SET', key('wa:qr'), await QRCode.toDataURL(update.qr, { width: 240, margin: 2 }), 'EX', 120);
        await status('waiting_qr');
      }
      if (update.connection === 'open') {
        ready = true;
        await redis('DEL', key('wa:qr'));
        await status('connected', { sendEnabled });
        console.log('WhatsApp conectado; envios:', sendEnabled ? 'habilitados' : 'bloqueados');
      }
      if (update.connection === 'close') {
        ready = false;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        await status(code === DisconnectReason.loggedOut ? 'logged_out' : 'disconnected');
        if (!stopping && code !== DisconnectReason.loggedOut) {
          clearTimeout(rejoinTimer);
          rejoinTimer = setTimeout(connect, 5000);
        }
      }
    });
  } catch (error) {
    ready = false;
    await status('error');
    console.error('Falha ao conectar:', error.message);
    if (!stopping) rejoinTimer = setTimeout(connect, 10000);
  }
}
async function shutdown() {
  stopping = true;
  ready = false;
  clearInterval(timer);
  clearTimeout(rejoinTimer);
  await status('stopping');
  try { socket?.ws?.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (!storeUrl || !storeToken || cipherKey.length !== 32) {
  console.error('Configure Redis e WA_AUTH_ENCRYPTION_KEY em produção');
  process.exit(1);
}
if (connectEnabled) await connect();
else await status('disabled');
timer = setInterval(async () => {
  if (!connectEnabled) await status('disabled');
  else if (ready) {
    await status('connected', { sendEnabled });
    await processDue();
  }
}, 30000);
console.log('Daemon de confirmação iniciado; conexão:', connectEnabled ? 'ativa' : 'desativada');
