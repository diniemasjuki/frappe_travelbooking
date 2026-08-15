/* ============================================================
   travel_booking/public/js/portal_transactions.js
   Page: /traveller_portal/transactions

   - Senarai FLAT semua transaksi (payment + invoice) merentasi booking
     — port dari renderSoList() portal_payment.js, semua nilai di-escape.
   - PAYMENT RESULT selepas redirect Stripe (port dari portal.js) —
     dengan fix audit: butang "Try again" kini BETUL-BETUL bawa customer
     ke Billing page booking berkenaan untuk bayar semula (sebelum ni
     kedua-dua butang buat perkara yang sama).
   ============================================================ */

'use strict';

/* ══════════════════════════════════════════════
   PAYMENT RESULT (redirect balik dari Stripe)
   ══════════════════════════════════════════════ */

async function _checkPaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const paymentIntentId = params.get('payment_intent');
  if (!paymentIntentId) return false;

  // Buang query params dari address bar (elak re-trigger bila refresh/back).
  window.history.replaceState({}, document.title, window.location.pathname);

  document.getElementById('pr-result').style.display = 'block';
  document.getElementById('txns-view').style.display = 'none';
  document.getElementById('pr-result-body').innerHTML =
    '<div class="pr-spinner"></div>' +
    '<div class="pr-title">Confirming your payment</div>' +
    '<div class="pr-sub">This usually takes a few seconds. Please don\'t close this page.</div>';

  try {
    const result = await API_STRIPE('get_payment_result', { payment_intent: paymentIntentId });
    renderPaymentResult(result);
  } catch (e) {
    renderPaymentResult({ status: 'unknown' });
  }
  return true;
}

function renderPaymentResult(result) {
  const body = document.getElementById('pr-result-body');
  const backBtn = '<button class="btn btn-p btn-full" onclick="_dismissPaymentResult()">View my transactions</button>';

  if (result.status === 'succeeded') {
    body.innerHTML =
      '<div class="pr-icon pr-icon-success">' +
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0F6E56" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>' +
      '</div>' +
      '<div class="pr-title">Payment successful</div>' +
      '<div class="pr-sub">Your payment has been received and confirmed.</div>' +
      '<div class="pr-details">' +
        '<div class="pr-row"><span>Amount paid</span><strong>' + _esc(result.currency || 'MYR') + ' ' + fmt(result.amount) + '</strong></div>' +
        (result.trip_label ? '<div class="pr-row"><span>Trip</span><strong>' + _esc(result.trip_label) + '</strong></div>' : '') +
        (result.sales_order ? '<div class="pr-row"><span>Sales order</span><strong style="font-family:monospace">' + _esc(result.sales_order) + '</strong></div>' : '') +
      '</div>' +
      backBtn;
  } else if (result.status === 'processing') {
    body.innerHTML =
      '<div class="pr-spinner"></div>' +
      '<div class="pr-title">Payment processing</div>' +
      '<div class="pr-sub">We\'ll update your booking as soon as this clears — usually within a few minutes. You\'ll also get an email confirmation.</div>' +
      backBtn;
  } else if (result.status === 'failed') {
    // FIX AUDIT (butang "Try again" palsu): kini betul-betul bawa customer
    // ke Billing page booking terlibat untuk cuba bayar semula — guna
    // booking_number dari metadata intent (bukan butang duplikasi back).
    const retryUrl = result.booking_number
      ? '/traveller_portal/booking_billing?ref=' + encodeURIComponent(result.booking_number)
      : '/traveller_portal/bookings';
    body.innerHTML =
      '<div class="pr-icon pr-icon-failed">' +
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#991B1B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</div>' +
      '<div class="pr-title">Payment failed</div>' +
      '<div class="pr-sub">' + _esc(result.last_error || 'Your card was declined.') + ' No amount has been charged — you can try again.</div>' +
      '<div class="pr-btn-row">' +
        '<button class="btn btn-g" onclick="_dismissPaymentResult()">Back to transactions</button>' +
        '<a class="btn btn-p" href="' + retryUrl + '" style="text-decoration:none;display:flex;align-items:center;justify-content:center;">Try again</a>' +
      '</div>';
  } else {
    body.innerHTML =
      '<div class="pr-icon pr-icon-failed">' +
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#991B1B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
      '</div>' +
      '<div class="pr-title">Couldn\'t confirm payment status</div>' +
      '<div class="pr-sub">Please check your transactions below, or contact us if you\'re unsure whether your payment went through.</div>' +
      backBtn;
  }
}

function _dismissPaymentResult() {
  document.getElementById('pr-result').style.display = 'none';
  document.getElementById('txns-view').style.display = '';
  window.scrollTo(0, 0);
}

/* ══════════════════════════════════════════════
   SENARAI TRANSAKSI (flat, merentasi semua booking)
   ══════════════════════════════════════════════ */

async function loadAllPayments() {
  const c = document.getElementById('so-list-container');
  c.innerHTML = '<div style="font-size:13px;color:#B0AC9F;padding:8px 0;">Loading transactions...</div>';
  try {
    const data = await API_PM('get_all_so_payments', {});
    renderTxnList(data.orders || []);
  } catch (e) {
    c.innerHTML =
      '<div class="card" style="text-align:center;padding:32px 20px;">' +
        '<div style="font-size:13px;color:#991B1B;margin-bottom:14px;">' + _esc(e.message || 'Failed to load transactions.') + '</div>' +
        '<button class="btn btn-g" onclick="window.location.reload()" style="font-size:12px;">Retry</button>' +
      '</div>';
  }
}

function renderTxnList(orders) {
  const container = document.getElementById('so-list-container');

  const txns = [];
  orders.forEach(so => {
    const bookingLabel = _esc((so.bookings || []).join(' · ') || so.name);
    const soSymbol = so.currency_symbol || 'RM';
    const soName = _esc(so.name);

    (so.payments || []).forEach(p => {
      txns.push({
        type: 'payment',
        sortDate: p.payment_date || '',
        title: _esc((p.mode_of_payment || 'Payment') + (p.status === 'Pending' ? ' (pending review)' : '')),
        subtitle: bookingLabel + ' · ' + soName,
        amount: parseFloat(p.paid_amount || 0),
        symbol: soSymbol,
        statusLabel: p.status === 'Verified' ? 'Verified' : p.status === 'Cancelled' ? 'Cancelled' : 'Pending',
        statusBg: p.status === 'Verified' ? '#E1F5EE' : p.status === 'Cancelled' ? '#FEE2E2' : '#F5F3EE',
        statusColor: p.status === 'Verified' ? '#085041' : p.status === 'Cancelled' ? '#991B1B' : '#5C5850',
        onClick: p.status === 'Verified' ? { dt: 'Payment Entry', dn: _esc(p.name) } : null,
        actionLabel: 'Receipt',
      });
    });

    (so.invoices || []).forEach(inv => {
      txns.push({
        type: 'invoice',
        sortDate: inv.posting_date || '',
        title: 'Invoice ' + _esc(inv.name),
        subtitle: bookingLabel + ' · ' + soName,
        amount: parseFloat(inv.grand_total || 0),
        symbol: soSymbol,
        statusLabel: null,
        onClick: { dt: 'Sales Invoice', dn: _esc(inv.name) },
        actionLabel: 'Download',
      });
    });
  });

  if (!txns.length) {
    container.innerHTML =
      '<div class="card" style="text-align:center;padding:40px 24px;">' +
        '<div style="font-size:32px;margin-bottom:10px;">🧾</div>' +
        '<div style="font-size:15px;font-weight:600;color:#1E1C18;margin-bottom:6px;">No transactions yet</div>' +
        '<p style="font-size:13px;color:#7D7A70;line-height:1.6;max-width:360px;margin:0 auto;">' +
          'Your payments and invoices will appear here once you make your first booking payment.</p>' +
        '<a href="/traveller_portal/bookings" class="btn btn-p" style="text-decoration:none;display:inline-block;margin-top:16px;">View My Bookings</a>' +
      '</div>';
    return;
  }

  txns.sort((a, b) => (b.sortDate || '').localeCompare(a.sortDate || ''));

  const paymentIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1" y="4" width="14" height="10" rx="2" stroke="#0F6E56" stroke-width="1.2"/><path d="M1 7h14" stroke="#0F6E56" stroke-width="1.2"/><rect x="3" y="9.5" width="4" height="1.5" rx="0.5" fill="#0F6E56"/></svg>';
  const invoiceIcon = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 2h7l3 3v9H3V2z" stroke="#185FA5" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="#185FA5" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 8h6M5 10.5h4" stroke="#185FA5" stroke-width="1.2" stroke-linecap="round"/></svg>';

  container.innerHTML = txns.map(t => {
    const isPayment = t.type === 'payment';
    const iconBg = isPayment ? '#E1F5EE' : '#E6F1FB';
    const icon = isPayment ? paymentIcon : invoiceIcon;
    const amountColor = isPayment && t.statusLabel === 'Verified' ? '#0F6E56' : '#1E1C18';
    const actionBtn = t.onClick
      ? '<button onclick="downloadDocument(this,\'' + t.onClick.dt + '\',\'' + t.onClick.dn + '\')" style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;border:1px solid #D3D1C7;background:transparent;color:#5C5850;cursor:pointer;">' + t.actionLabel + '</button>'
      : '';

    return (
      '<div style="background:#fff;border:1px solid #EAE7E0;border-radius:12px;padding:16px 18px;margin-bottom:10px;display:flex;align-items:center;gap:14px;">' +
        '<div style="width:36px;height:36px;border-radius:10px;background:' + iconBg + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + icon + '</div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:13px;font-weight:600;color:#1E1C18;">' + t.title + '</div>' +
          '<div style="font-size:12px;color:#B0AC9F;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + t.subtitle + (t.sortDate ? ' · ' + _esc(fmtDate(t.sortDate)) : '') + '</div>' +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0;">' +
          '<div style="font-size:14px;font-weight:600;color:' + amountColor + ';white-space:nowrap;">' + _esc(t.symbol) + ' ' + fmt(t.amount) + '</div>' +
          '<div style="margin-top:4px;display:flex;align-items:center;gap:6px;justify-content:flex-end;">' +
            (t.statusLabel ? '<span style="font-size:11px;font-weight:600;padding:2px 10px;border-radius:14px;background:' + t.statusBg + ';color:' + t.statusColor + ';">' + t.statusLabel + '</span>' : '') +
            actionBtn +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');
}

/* downloadDocument — salinan ringkas portal_billing.js (fallback popup). */
async function downloadDocument(btn, doctype, docname) {
  const orig = btn.innerText.trim();
  btn.textContent = '...';
  btn.disabled = true;
  let win = null;
  try { win = window.open('', '_blank'); } catch (e) {}
  if (win) win.document.write('<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>Generating document...</p></body></html>');
  try {
    const res = await fetch('/api/method/travel_booking.api.portal_payment.get_document_pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': _csrfToken() },
      credentials: 'include',
      body: JSON.stringify({ doctype, docname })
    });
    if (!res.ok) { if (win) win.close(); alert('Document not available.'); return; }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    if (win) { win.location.href = blobUrl; }
    else {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = docname.replace(/\//g, '-') + '.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
  } catch (e) {
    if (win) win.close();
    alert('Connection error: ' + (e.message || 'Please try again.'));
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', async () => {
  const cameFromPayment = await _checkPaymentReturn();
  const ok = await ensureSession();
  if (!ok) return;
  renderNav();
  if (!cameFromPayment) await loadAllPayments();
  else await loadAllPayments(); // senarai sentiasa refresh (data bayaran baharu)
});
