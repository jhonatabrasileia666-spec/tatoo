const { timingSafeEqual } = require('node:crypto');
const { redis, key, getBooking, setBooking, send } = require('./_store');
const checkKey = (token) => {
  const real = process.env.TATTOO_ADMIN_TOKEN || '';
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(real);
  return real.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
};
module.exports = async function handler(req, res) {
  if (!process.env.TATTOO_ADMIN_TOKEN) return send(res, 503, { error: 'Painel ainda não configurado' });
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ') || !checkKey(authorization.slice(7)))
    return send(res, 401, { error: 'Acesso não autorizado' });
  try {
    if (req.method === 'GET') {
      const action = String(req.query.action || 'list');
      if (action === 'whatsapp') {
        const [raw, qr] = await Promise.all([redis('GET', key('wa:status')), redis('GET', key('wa:qr'))]);
        return send(res, 200, { status: raw ? JSON.parse(raw) : { state: 'offline' }, qr: qr || null });
      }
      if (action === 'list') {
        const ids = await redis('ZREVRANGE', key('bookings'), 0, 199);
        const raw = ids?.length ? await redis('MGET', ...ids.map(id => key('booking:' + id))) : [];
        const bookings = raw.filter(Boolean).map(item => JSON.parse(item));
        return send(res, 200, { bookings });
      }
      return send(res, 400, { error: 'Consulta inválida' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Método não permitido' });
    const { id, action } = req.body || {};
    const booking = await getBooking(id);
    if (!booking) return send(res, 404, { error: 'Agendamento não encontrado' });
    if (action === 'approve') {
      if (booking.status !== 'requested') return send(res, 409, { error: 'Agendamento já processado' });
      booking.status = 'confirmed';
      booking.approvedAt = new Date().toISOString();
      const appointment = Date.parse(booking.appointmentAt);
      if (appointment > Date.now() + 30 * 60000) {
        const due = Math.max(Date.now() + 60000, appointment - 2 * 3600000);
        booking.reminderDueAt = new Date(due).toISOString();
        // Persistir antes de ativar o agendamento da notificação.
        await setBooking(booking);
        await redis('ZADD', key('reminders'), due, booking.id);
      } else {
        booking.reminderSkipped = true;
        await setBooking(booking);
      }
      return send(res, 200, { booking });
    }
    if (action === 'cancel') {
      if (['cancelled', 'client_cancelled'].includes(booking.status)) return send(res, 409, { error: 'Já cancelado' });
      booking.status = 'cancelled';
      booking.cancelledAt = new Date().toISOString();
      await setBooking(booking);
      await redis('ZREM', key('reminders'), booking.id);
      const slot = key('slot:' + booking.date + ':' + booking.time);
      if (await redis('GET', slot) === booking.id) await redis('DEL', slot);
      return send(res, 200, { booking });
    }
    return send(res, 400, { error: 'Ação inválida' });
  } catch (error) {
    console.error('admin failed:', error.message);
    return send(res, 503, { error: 'Não foi possível consultar o painel agora' });
  }
};
