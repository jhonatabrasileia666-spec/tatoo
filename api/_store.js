// Redis REST (Upstash): estado persistente compartilhado entre Functions e Daemon.
// Configure UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN no ambiente da Vercel.
const PREFIX = 'tatuador:v1:';
async function redis() {
  const args = Array.from(arguments);
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Armazenamento não configurado');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('Falha no armazenamento');
  const body = await response.json();
  if (body.error) throw new Error('Falha no armazenamento');
  return body.result;
}
const key = (name) => PREFIX + name;
function json(value) { return JSON.stringify(value); }
async function getBooking(id) {
  if (!/^[a-f0-9-]{36}$/.test(id || '')) return null;
  const raw = await redis('GET', key('booking:' + id));
  return raw ? JSON.parse(raw) : null;
}
async function setBooking(booking) {
  await redis('SET', key('booking:' + booking.id), json(booking), 'EX', 15552000);
}
function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}
function normalizePhone(raw) {
  let value = String(raw || '').replace(/\D/g, '');
  if ((value.length === 10 || value.length === 11)) value = '55' + value;
  return /^55\d{10,11}$/.test(value) ? value : null;
}
function appointmentMs(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return NaN;
  if (!['09:00', '10:30', '14:00', '16:30', '18:00'].includes(time)) return NaN;
  const timestamp = Date.parse(date + 'T' + time + ':00-04:00');
  if (!Number.isFinite(timestamp) || new Date(timestamp - (-4 * 3600000)).toISOString().slice(0, 10) !== date) return NaN;
  return timestamp;
}
module.exports = { redis, key, getBooking, setBooking, send, normalizePhone, appointmentMs };
