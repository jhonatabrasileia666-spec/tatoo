// Acrescenta agendamento real ao site existente sem alterar a arte/galeria.
(() => {
  window.tattooBusySlots = [];
  const $ = (selector) => document.querySelector(selector);
  const text = (selector, value) => { const node = $(selector); if (node) node.textContent = value; };
  const initial = $('.notice');
  if (initial) initial.textContent = 'AGENDAMENTO ONLINE — SOLICITAÇÕES SUJEITAS À APROVAÇÃO DO ESTÚDIO';
  text('#submitBooking', 'Solicitar horário');
  text('#bookingForm .disclaimer', 'Seu horário será reservado provisoriamente e confirmado pelo estúdio. Você poderá receber um lembrete pelo WhatsApp.');
  text('#bookingForm .consent span', 'Autorizo contato pelo WhatsApp para confirmar e lembrar deste agendamento.');
  text('.slot-note span', 'Horários sujeitos à disponibilidade e à aprovação do tatuador.');
  const modal = $('#successOverlay');
  if (modal) {
    text('#successOverlay .eyebrow', 'SOLICITAÇÃO RECEBIDA');
    text('#successOverlay h3', 'Pedido enviado!');
    text('#successOverlay .success-body p', 'O estúdio analisará sua solicitação. O horário somente estará confirmado após a aprovação.');
    const a = $('#successOverlay .success-body a');
    if (a) a.textContent = 'Falar com o tatuador ↗';
  }
  let lastDate = '', requestNumber = 0;
  async function refresh() {
    const selected = window.tattooBookingState?.();
    if (!selected?.date) return;
    const date = selected.date;
    const request = ++requestNumber;
    try {
      const response = await fetch('/api/bookings?date=' + encodeURIComponent(date), { cache: 'no-store' });
      if (!response.ok) throw new Error('Não foi possível verificar os horários.');
      const result = await response.json();
      if (request !== requestNumber || window.tattooBookingState?.().date !== date) return;
      const busy = (result.occupied || []).map(time => date + 'T' + time);
      const next = JSON.stringify(busy);
      if (JSON.stringify(window.tattooBusySlots) !== next) {
        window.tattooBusySlots = busy;
        window.tattooRefreshSlots?.();
      }
      lastDate = date;
    } catch (error) { console.warn('Agenda ainda indisponível:', error.message); }
  }
  document.addEventListener('click', event => {
    if (event.target.closest('#calendarGrid button')) setTimeout(refresh, 0);
  });
  refresh();
  const form = $('#bookingForm');
  if (!form) return;
  form.addEventListener('submit', async event => {
    // Captura antes do listener original (que apenas simula um agendamento).
    event.preventDefault();
    event.stopImmediatePropagation();
    const selected = window.tattooBookingState?.();
    if (!selected?.date || !selected?.time) {
      alert('Escolha uma data e horário antes de solicitar.');
      return;
    }
    const button = $('#submitBooking');
    button.disabled = true;
    button.textContent = 'Enviando solicitação...';
    try {
      const payload = {
        name: $('#clientName').value.trim(),
        phone: $('#clientPhone').value,
        email: $('#clientEmail').value.trim(),
        notes: $('#clientNotes').value.trim(),
        date: selected.date, time: selected.time,
        price: $('#estimatePrice').textContent,
        consent: $('#consent').checked
      };
      const response = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Erro ao solicitar horário');
      const container = $('#successDetails');
      if (container) {
        container.replaceChildren();
        [['Protocolo', result.id.slice(0, 8).toUpperCase()],
         ['Nome', payload.name], ['Data', payload.date],
         ['Horário solicitado', payload.time], ['Situação', 'Aguardando aprovação do estúdio']]
          .forEach(([label, value]) => {
            const line = document.createElement('div');
            const strong = document.createElement('strong');
            strong.textContent = label + ': ';
            line.append(strong, document.createTextNode(value));
            container.append(line);
          });
      }
      form.reset();
      window.tattooOpenModal?.('successOverlay');
      await refresh();
    } catch (error) {
      alert(error.message + '\nNenhum horário foi confirmado. Tente novamente.');
      await refresh();
    } finally {
      button.disabled = false;
      button.textContent = 'Solicitar horário';
    }
  }, true);
})();
