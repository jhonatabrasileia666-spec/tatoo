const { randomUUID } = require('node:crypto');
const { redis, key, setBooking, send, normalizePhone, appointmentMs } = require('./_store');
const TIMES = ['09:00', '10:30', '14:00', '16:30', '18:00'];
module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const date = String(req.query.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: 'Data inválida' });
      const values = await redis('MGET', ...TIMES.map(t => key('slot:' + date + ':' + t)));
      return send(res, 200, { occupied: TIMES.filter((_, i) => Boolean(values?.[i])) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Método não permitido' });
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 90);
    const phone = normalizePhone(b.phone);
    const email = String(b.email || '').trim().slice(0, 120);
    const notes = String(b.notes || '').trim().slice(0, 700);
    const date = String(b.date || '');
    const time = String(b.time || '');
    const appointment = appointmentMs(date, time);
    if (name.length < 3 || !phone || !b.consent || !Number.isFinite(appointment))
      return send(res, 400, { error: 'Dados obrigatórios inválidos' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return send(res, 400, { error: 'E-mail inválido' });
    const now = Date.now();
    if (appointment < now + 30 * 60000 || appointment > now + 91 * 86400000)
      return send(res, 400, { error: 'Escolha um horário válido entre amanhã e os próximos 90 dias' });
    // Não aceitar domingos.
    if (new Date(date + 'T12:00:00-04:00').getUTCDay() === 0)
      return send(res, 400, { error: 'Não atendemos aos domingos' });
    const id = randomUUID();
    const slotKey = key('slot:' + date + ':' + time);
    const ttl = Math.max(3600, Math.ceil((appointment - now) / 1000) + 86400);
    const claimed = await redis('SET', slotKey, id, 'EX', ttl, 'NX');
    if (claimed !== 'OK') return send(res, 409, { error: 'Esse horário já está reservado. Escolha outro.' });
    const booking = {
      id, name, phone, email, notes, date, time,
      estimate: String(b.price || '').slice(0, 100),
      status: 'requested', consentAt: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(), appointmentAt: new Date(appointment).toISOString()
    };
    try {
      await setBooking(booking);
      await redis('ZADD', key('bookings'), now, id);
    } catch (error) {
      // Liberar apenas nosso slot: nenhuma mensagem deve ser enviada se não foi salvo.
      if (await redis('GET', slotKey) === id) await redis('DEL', slotKey);
      throw error;
    }
    return send(res, 201, { id, status: 'requested', message: 'Solicitação recebida. Aguarde a confirmação do estúdio.' });
  } catch (error) {
    console.error('bookings failed:', error.message);
    return send(res, 503, { error: 'Agendamento temporariamente indisponível. Tente novamente.' });
  }
};
