/* ============================================================
   travel_booking/public/js/portal_billing.js
   Page: /traveller_portal/booking_billing?ref=...

   Susun atur halaman (atas → bawah):
   1. Ringkasan booking — progress bar bayaran + statistik
      (Total Billed / Total Paid / Balance Due)
   2. Senarai Sales Order collapsible:
      - Header: no. SO + label booking + jumlah + status pill
      - Body: Line Items → Documents → Transactions → Make a Payment
   3. Documents (kondisional):
      - SO belum lunas + proforma issued → baris Proforma Invoice + "↓ Proforma"
        (PDF sebenar dari doctype Proforma Invoice, dijana admin di Desk)
      - SO belum lunas, tiada proforma   → nota "proforma akan muncul di sini"
      - SO lunas + SI wujud → baris Sales Invoice + "↓ Invoice"
      - SO lunas, tiada SI  → nota "invoice akan muncul di sini"
   4. Transactions — senarai Payment Entry untuk SO tersebut
      (status Verified/Pending/Cancelled + ↓ Receipt)
   5. Make a Payment (hanya jika ada baki) — corak borang dipinjam
      dari wizard booking.html Step 3: kotak amount besar + chip
      Deposit/Full, kaedah radio Online / Manual Bank Transfer,
      borang manual menunjukkan butir bank (per currency, dari
      Travel Settings — TIADA fallback butir bank palsu).

   Semua render di-escape guna _esc(); interaksi melalui event
   delegation (data-act) — tiada onclick string yang boleh pecah
   oleh quote dalam nama dokumen.
   ============================================================ */

'use strict';

const _payFiles = {};   // soId → File (bukti bayaran manual)
let BOOKING = '';
let BANK_ACCOUNTS = {}; // {currency: {bank_name, account_name, account_number}}
let CASHBACK = { enabled: false, percent: 0 };
let DEPOSIT_PCT = 20;   // Travel Settings.default_deposit_percent
let ONLINE_PAYMENT_ENABLED = true;  // dari Travel Settings payment_gateway_account
const SO_CTX = {};      // soId → {name, symbol, min, max}
let _cachedOrders = null;   // bookingOrders cache (for currency re-render)


/* ══════════════════════════════════════════════
   LOAD + RENDER UTAMA
   ══════════════════════════════════════════════ */

async function loadBookingPayments() {
  const container = document.getElementById('booking-pi-container');
  if (!container) return;

  container.innerHTML = '<div style="font-size:13px;color:#B0AC9F;padding:8px 0;">Loading payment details...</div>';
  try {
    _cachedOrders = null;
    const data = await API_PM('get_all_so_payments', {});
    const bookingOrders = (data.orders || []).filter(so =>
      (so.booking_numbers || []).includes(BOOKING)
    );

    if (!bookingOrders.length) {
      container.innerHTML =
        '<div class="card" style="text-align:center;padding:32px 20px;font-size:13px;color:#7D7A70;">' +
        'No billing records for this booking yet. If you just made this booking, ' +
        'records will appear here shortly.</div>';
      return;
    }

    // Butir bank + deposit % + cashback (untuk borang bayar) — gagal load
    // bukan fatal: halaman tetap papar, cuma kaedah Manual dilumpuhkan.
    try {
      const s = await _post('/api/method/travel_booking.api.pricing.get_payment_settings', {});
      BANK_ACCOUNTS = (s && s.bank_accounts) || {};
      CASHBACK = { enabled: !!s.cashback_enabled, percent: parseFloat(s.cashback_percent || 0) };
      DEPOSIT_PCT = parseFloat(s.default_deposit_percent || 20);
      ONLINE_PAYMENT_ENABLED = s && s.online_payment_enabled !== false;
    } catch (e) { /* kekal default; manual option akan dilumpuhkan */ }

    _cachedOrders = bookingOrders;
    renderBilling();
    bindBillingEvents(container);
  } catch (e) {
    container.innerHTML =
      '<div class="card" style="text-align:center;padding:32px 20px;">' +
        '<div style="font-size:13px;color:#991B1B;margin-bottom:14px;">' + _esc(e.message || 'Failed to load billing.') + '</div>' +
        '<button class="btn btn-g" data-act="reload" style="font-size:12px;">Retry</button>' +
      '</div>';
  }
}


/* Re-render billing dari cache (currency refresh) — tanpa re-fetch.
   bindBillingEvents() TIDAK dipanggil semula: listener delegation pada
   container kekal aktif selepas innerHTML ditukar. */
function renderBilling() {
  const container = document.getElementById('booking-pi-container');
  if (!container || !_cachedOrders) return;
  container.innerHTML =
    renderSummaryCard(_cachedOrders) +
    _cachedOrders.map(renderSoCard).join('');
}


/* ══════════════════════════════════════════════
   1. RINGKASAN BOOKING — progress bar + statistik
   ══════════════════════════════════════════════ */

function renderSummaryCard(orders) {
  const active = orders.filter(so => !so.is_cancelled);
  const grandTotal  = active.reduce((a, so) => a + parseFloat(so.grand_total || 0), 0);
  const totalPaid   = active.reduce((a, so) => a + parseFloat(so.advance_paid || 0), 0);
  const outstanding = Math.max(grandTotal - totalPaid, 0);
  const pct         = grandTotal > 0 ? Math.min((totalPaid / grandTotal) * 100, 100) : 0;
  const isPaid      = outstanding <= 0.001;
  const symbol      = (orders.find(so => so.currency_symbol) || {}).currency_symbol || 'RM';
  const settled     = active.filter(so =>
    parseFloat(so.grand_total || 0) - parseFloat(so.advance_paid || 0) <= 0.001
  ).length;
  const label = (orders[0] && orders[0].bookings && orders[0].bookings[0]) || BOOKING;

  return (
    '<div class="card" style="padding:20px;margin-bottom:20px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:10px;">' +
        '<div style="min-width:0;">' +
          '<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#B0AC9F;">Booking</div>' +
          '<div style="font-size:15px;font-weight:500;color:#1E1C18;margin-top:2px;">' + _esc(label) + '</div>' +
        '</div>' +
        '<div style="font-size:13px;color:#7D7A70;flex-shrink:0;">' + pct.toFixed(0) + '% paid</div>' +
      '</div>' +
      '<div class="bill-progress' + (isPaid ? ' done' : '') + '" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct) + '" aria-label="Payment progress">' +
        '<div style="width:' + pct.toFixed(1) + '%;"></div>' +
      '</div>' +
      '<div style="font-size:12px;color:' + (isPaid ? '#0F6E56' : '#7D7A70') + ';margin-top:8px;">' +
        (isPaid
          ? 'Paid in full — thank you ✓'
          : fmtDual(outstanding, symbol) + ' remaining to be paid') +
      '</div>' +
      '<div class="bill-stats" style="margin-top:16px;">' +
        '<div><div class="l">Total Billed</div><div class="v">' + fmtDual(grandTotal, symbol) + '</div></div>' +
        '<div><div class="l">Total Paid</div><div class="v" style="color:#0F6E56;">' + fmtDual(totalPaid, symbol) + '</div></div>' +
        '<div><div class="l">Balance Due</div><div class="v" style="color:' + (isPaid ? '#0F6E56' : '#92400E') + ';">' +
          (isPaid ? '—' : fmtDual(outstanding, symbol)) + '</div></div>' +
      '</div>' +
      (active.length > 1
        ? '<div style="font-size:11px;color:#B0AC9F;margin-top:10px;">' + settled + ' of ' + active.length + ' orders settled</div>'
        : '') +
    '</div>'
  );
}


/* ══════════════════════════════════════════════
   2. KAD SALES ORDER (collapsible)
   ══════════════════════════════════════════════ */

function renderSoCard(so) {
  const total       = parseFloat(so.grand_total || 0);
  const paid        = parseFloat(so.advance_paid || 0);
  const outstanding = Math.max(total - paid, 0);
  const pct         = total > 0 ? Math.min((paid / total) * 100, 100) : 0;
  const isPaid      = outstanding <= 0.001;
  const soId        = so.name.replace(/[^a-zA-Z0-9]/g, '-');
  const symbol      = so.currency_symbol || 'RM';
  const isCancelled = !!so.is_cancelled;
  const depositAmt  = Math.round(total * (DEPOSIT_PCT / 100) * 100) / 100;
  // Selari dengan create_payment_request(): bayaran pertama mesti ≥ deposit,
  // selepas itu minima RM 1 ( nilai serupa dikuatkuasakan di server).
  const minAmt      = paid <= 0 ? depositAmt : 1.0;

  SO_CTX[soId] = { name: so.name, symbol, min: minAmt, max: outstanding };

  const subtitle =
    ((so.bookings && so.bookings[0]) || '') +
    (so.transaction_date ? ' · ' + fmtDate(so.transaction_date) : '');

  const statusPill = isCancelled
    ? '<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:#FEE2E2;color:#991B1B;">Cancelled</span>'
    : isPaid
      ? '<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:#E1F5EE;color:#085041;">Settled ✓</span>'
      : '<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:#FEF3C7;color:#92400E;">' + pct.toFixed(0) + '% paid</span>';

  return (
    '<div class="bill-so" id="so-card-' + soId + '">' +

      '<button type="button" class="bill-so-head" data-act="toggle-so" data-so="' + soId + '" aria-expanded="false" aria-controls="so-body-' + soId + '">' +
        '<div style="min-width:0;">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
            '<span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#B0AC9F;">Sales Order</span>' +
            (isCancelled ? statusPill : '') +
          '</div>' +
          '<div style="font-size:14px;font-weight:500;font-family:monospace;color:#1E1C18;margin-top:2px;word-break:break-all;">' + _esc(so.name) + '</div>' +
          (subtitle ? '<div style="font-size:12px;color:#7D7A70;margin-top:2px;">' + _esc(subtitle) + '</div>' : '') +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">' +
          '<div style="text-align:right;">' +
            '<div style="font-size:15px;font-weight:500;color:#1E1C18;">' + fmtDual(total, symbol) + '</div>' +
            (isCancelled ? '' : '<span style="display:inline-block;margin-top:3px;">' + statusPill + '</span>') +
          '</div>' +
          '<svg class="bill-so-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
            '<path d="M4 6l4 4 4-4" stroke="#B0AC9F" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</div>' +
      '</button>' +

      '<div class="bill-so-body" id="so-body-' + soId + '">' +
        renderItemsSection(so, symbol, total) +
        renderDocumentsSection(so, symbol, isPaid, isCancelled) +
        renderTransactionsSection(so, symbol) +
        renderPaymentSection(so, soId, symbol, outstanding, paid, depositAmt, minAmt, isCancelled) +
      '</div>' +
    '</div>'
  );
}


/* ── Line items ── */
function renderItemsSection(so, symbol, total) {
  const rows = (so.items || []).map(item => {
    const amt = parseFloat(item.amount || 0);
    const isDiscount = amt < 0;
    const qty = parseFloat(item.qty || 1);
    const label = _esc((item.item_name || '')
      .replace(/\s*\(Cabin\s*\d+\)\s*/i, ' ')
      .replace(/\s*—\s*/g, ' · ')
      .replace(/\s{2,}/g, ' ')
      .trim());
    return (
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid #EAE7E0;">' +
        '<div style="font-size:12px;color:' + (isDiscount ? '#0F6E56' : '#1E1C18') + ';min-width:0;">' + label +
          (qty > 1 ? ' <span style="color:#B0AC9F;">×' + qty.toFixed(0) + '</span>' : '') + '</div>' +
        '<div style="font-size:12px;font-weight:500;color:' + (isDiscount ? '#0F6E56' : '#1E1C18') + ';white-space:nowrap;">' +
          (isDiscount ? '-' : '') + fmtDual(Math.abs(amt), symbol) + '</div>' +
      '</div>'
    );
  }).join('');

  if (!rows) return '';

  return (
    '<div class="bill-sec">Line Items</div>' + rows +
    '<div style="display:flex;justify-content:space-between;align-items:center;padding-top:12px;margin-top:-1px;border-top:3px solid #D3D1C7;">' +
      '<div style="font-size:13px;font-weight:500;color:#1E1C18;">Total</div>' +
      '<div style="font-size:13px;font-weight:500;color:#C9A84C;">' + fmtDual(total, symbol) + '</div>' +
    '</div>'
  );
}


/* ── Documents: proforma (belum lunas) / invoice (lunas) ── */
function renderDocumentsSection(so, symbol, isPaid, isCancelled) {
  if (isCancelled) return '';

  const docIcon = (bg, stroke) =>
    '<div style="width:32px;height:32px;border-radius:8px;background:' + bg + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
      '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 2h7l3 3v9H3V2z" stroke="' + stroke + '" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="' + stroke + '" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 8h6M5 10.5h4" stroke="' + stroke + '" stroke-width="1.2" stroke-linecap="round"/></svg></div>';

  const dlBtn = (doctype, docname, label) =>
    '<button data-act="doc" data-doctype="' + _esc(doctype) + '" data-docname="' + _esc(docname) + '" ' +
      'style="font-size:11px;font-weight:500;padding:4px 12px;border-radius:6px;border:1px solid #D3D1C7;background:transparent;color:#5C5850;cursor:pointer;flex-shrink:0;margin-left:12px;white-space:nowrap;">' +
      label + '</button>';

  let body = '';
  if (!isPaid) {
    // Belum lunas → Proforma Invoice SEBENAR (ERPNext doctype, dipaut ke SO
    // via sales_order). Kalau admin dah issue, papar senarai + download PDF
    // sebenar (proforma_pdf). Kalau belum diissue, nota neutral — BUKAN
    // cetakan SO semula seperti implementasi lama (lihat get_document_pdf
    // branch "Proforma Invoice").
    const proformas = so.proformas || [];
    if (proformas.length) {
      body = proformas.map((p, i) =>
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;' +
          (i > 0 ? 'border-top:1px solid #EAE7E0;' : '') + '">' +
          '<div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
            docIcon('#E6F1FB', '#185FA5') +
            '<div><div style="font-size:13px;font-weight:500;color:#1E1C18;font-family:monospace;">' + _esc(p.name) + '</div>' +
            '<div style="font-size:11px;color:#B0AC9F;margin-top:1px;">' +
              (p.proforma_date ? _esc(fmtDate(p.proforma_date)) + ' · ' : '') +
              fmtDual(p.grand_total, symbol) + '</div></div>' +
          '</div>' + dlBtn('Proforma Invoice', p.name, '↓ Proforma') +
        '</div>'
      ).join('');
    } else {
      body = '<div style="font-size:12px;color:#B0AC9F;padding:8px 0;">Your proforma invoice will appear here once it has been issued.</div>';
    }
  } else if ((so.invoices || []).length) {
    // Lunas + SI wujud → ganti proforma dengan invoice rasmi.
    body = so.invoices.map((inv, i) =>
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;' +
        (i > 0 ? 'border-top:1px solid #EAE7E0;' : '') + '">' +
        '<div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
          docIcon('#E1F5EE', '#0F6E56') +
          '<div><div style="font-size:13px;font-weight:500;color:#1E1C18;font-family:monospace;">' + _esc(inv.name) + '</div>' +
          '<div style="font-size:11px;color:#B0AC9F;margin-top:1px;">' +
            _esc(fmtDate(inv.posting_date) || '-') + ' · ' + fmtDual(inv.grand_total, symbol) + '</div></div>' +
        '</div>' + dlBtn('Sales Invoice', inv.name, '↓ Invoice') +
      '</div>'
    ).join('');
  } else {
    body = '<div style="font-size:12px;color:#B0AC9F;padding:8px 0;">Official invoice will appear here once it has been generated.</div>';
  }

  return '<div class="bill-sec-row"><div class="bill-sec">Documents</div>' + body + '</div>';
}


/* ── Transactions: senarai Payment Entry untuk SO ini ── */
function renderTransactionsSection(so, symbol) {
  // Ikon berbeza ikut saluran: kad (online/gateway) vs bank (manual upload).
  const payIcon = (channel, color) => {
    const isOnline = channel === 'online';
    const glyph = isOnline
      // Kad: rect + strip magnetik
      ? '<rect x="1" y="4" width="14" height="10" rx="2" stroke="' + color + '" stroke-width="1.2"/>' +
        '<path d="M1 7h14" stroke="' + color + '" stroke-width="1.2"/>' +
        '<rect x="3" y="9.5" width="4" height="1.5" rx="0.5" fill="' + color + '"/>'
      // Bank: bumbung + tiang
      : '<path d="M2.5 6.5L8 2.5l5.5 4" stroke="' + color + '" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>' +
        '<path d="M3.5 7v5.5M8 7v5.5M12.5 7v5.5" stroke="' + color + '" stroke-width="1.2"/>' +
        '<path d="M2 12.5h12" stroke="' + color + '" stroke-width="1.2" stroke-linecap="round"/>';
    return (
      '<div style="width:36px;height:36px;border-radius:10px;background:#E1F5EE;display:flex;align-items:center;justify-content:center;flex-shrink:0;" ' +
        'title="' + _esc(isOnline ? 'Paid via payment gateway' : 'Paid by bank transfer (manual)') + '">' +
        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' + glyph + '</svg></div>'
    );
  };

  const rows = (so.payments || []).length > 0
    ? so.payments.map(p => {
        const isVerified  = p.status === 'Verified';
        const isCancelled = p.status === 'Cancelled';
        const sc = isVerified
          ? { bg: '#E1F5EE', color: '#085041', label: '✓ Verified' }
          : isCancelled
            ? { bg: '#FEE2E2', color: '#991B1B', label: '✕ Cancelled' }
            : { bg: '#F5F3EE', color: '#5C5850', label: 'Pending' };
        const icon = payIcon(p.channel, isVerified ? '#0F6E56' : '#888780');
        const title = p.channel_label || p.mode_of_payment || 'Payment';
        return (
          '<div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid #EAE7E0;">' +
            icon +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-size:13px;font-weight:500;color:#1E1C18;margin-bottom:2px;">' + _esc(title) + '</div>' +
              '<div style="font-size:12px;color:#7D7A70;">' + _esc(fmtDate(p.payment_date) || '-') + ' · Ref: ' + _esc(p.reference_no || '-') + '</div>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">' +
              '<div style="font-size:13px;font-weight:500;color:' + (isVerified ? '#0F6E56' : '#1E1C18') + ';">' + fmtDual(p.paid_amount, symbol) + '</div>' +
              '<div style="display:flex;align-items:center;gap:6px;">' +
                '<span style="font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;background:' + sc.bg + ';color:' + sc.color + ';">' + sc.label + '</span>' +
                (isVerified
                  ? '<button data-act="doc" data-doctype="Payment Entry" data-docname="' + _esc(p.name) + '" style="font-size:11px;font-weight:500;padding:4px 10px;border-radius:6px;border:1px solid #D3D1C7;background:transparent;color:#5C5850;cursor:pointer;">↓ Receipt</button>'
                  : '') +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }).join('')
    : '<div style="font-size:13px;color:#B0AC9F;padding:14px 0;">No transactions yet.</div>';

  return '<div class="bill-sec-row"><div class="bill-sec">Transactions</div>' + rows + '</div>';
}


/* ── Make a Payment — corak borang wizard booking.html Step 3 ── */
function renderPaymentSection(so, soId, symbol, outstanding, paid, depositAmt, minAmt, isCancelled) {
  if (isCancelled || outstanding <= 0.001) return '';

  const bank = BANK_ACCOUNTS[so.currency || 'MYR'];
  const hasBank = !!(bank && bank.account_number);

  const manualDesc = !hasBank
    ? 'Unavailable for ' + _esc(so.currency || 'this currency') + ' — please pay online or contact us'
    : CASHBACK.enabled && CASHBACK.percent > 0
      ? 'Get ' + CASHBACK.percent + '% cashback when you pay via bank transfer'
      : 'Verified within 1–2 business days';

  // Chip Deposit hanya relevan sebelum bayaran pertama.
  const chipsHtml = paid <= 0
    ? '<button type="button" class="pay-chip" data-act="chip" data-so="' + soId + '" data-amt="' + depositAmt.toFixed(2) + '">' +
        '<span class="pay-chip__label">Deposit (' + DEPOSIT_PCT + '%)</span>' +
        '<span class="pay-chip__amt">' + fmtDual(depositAmt, symbol) + '</span></button>' +
      '<button type="button" class="pay-chip on" data-act="chip" data-so="' + soId + '" data-amt="' + outstanding.toFixed(2) + '">' +
        '<span class="pay-chip__label">Full balance</span>' +
        '<span class="pay-chip__amt">' + fmtDual(outstanding, symbol) + '</span></button>'
    : '<button type="button" class="pay-chip on" data-act="chip" data-so="' + soId + '" data-amt="' + outstanding.toFixed(2) + '">' +
        '<span class="pay-chip__label">Full balance</span>' +
        '<span class="pay-chip__amt">' + fmtDual(outstanding, symbol) + '</span></button>';

  const bankHtml = hasBank
    ? '<div class="bank-details">' +
        '<div class="bank-row"><span>Bank</span><strong>' + _esc(bank.bank_name || '-') + '</strong></div>' +
        '<div class="bank-row"><span>Account Name</span><strong>' + _esc(bank.account_name || '-') + '</strong></div>' +
        '<div class="bank-row"><span>Account No</span><strong>' + _esc(bank.account_number || '-') + '</strong></div>' +
      '</div>'
    : '';

  return (
    '<div class="bill-sec-row">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px;">' +
        '<div class="bill-sec" style="margin:0;">Make a Payment</div>' +
        '<div style="font-size:12px;color:#7D7A70;">Balance due <strong style="color:#92400E;">' + fmtDual(outstanding, symbol) + '</strong></div>' +
      '</div>' +

      /* Amount — sama macam wizard: input besar + chip pantas */
      '<div class="pay-amount">' +
        '<span class="pay-amount__prefix">' + _esc(RC.company_symbol || symbol) + '</span>' +
        '<input type="number" class="pay-amount__input" id="pay-amt-' + soId + '" inputmode="decimal" step="0.01" min="0" value="' + outstanding.toFixed(2) + '" aria-label="Amount to pay"/>' +
      '</div>' +
      '<div style="font-size:11px;color:#B0AC9F;margin-top:5px;">' +
        'Min ' + fmtDual(minAmt, symbol) + ' · Max ' + fmtDual(outstanding, symbol) +
        (paid <= 0 ? ' · first payment must be at least the deposit' : '') +
      '</div>' +
      '<div class="pay-quick">' + chipsHtml + '</div>' +
      '<div id="pay-err-' + soId + '" role="alert" style="display:none;font-size:11px;color:#C0392B;margin-top:8px;"></div>' +

      /* Kaedah — radio-style macam wizard Payment Method.
         Online Payment disembunyikan/dilumpuhkan kalau tiada payment
         gateway diconfigure di Travel Settings (mirror pattern Manual
         Transfer disabled di bawah). */
      '<div class="pay-opts" style="margin-top:14px;">' +
        (ONLINE_PAYMENT_ENABLED
          ? '<label class="pay-opt on" data-act="method" data-so="' + soId + '" data-kind="online">' +
              '<input type="radio" name="paym-' + soId + '" value="online" checked/>' +
              '<span style="flex:1;min-width:0;">' +
                '<span class="pay-opt__label">Online Payment</span>' +
                '<span class="pay-opt__desc">Pay securely by debit or credit card</span>' +
              '</span>' +
            '</label>'
          : '<div class="pay-opt disabled">' +
              '<span style="flex:1;min-width:0;">' +
                '<span class="pay-opt__label">Online Payment</span>' +
                '<span class="pay-opt__desc" style="color:#991B1B;">Not available — no payment gateway configured</span>' +
              '</span>' +
            '</div>') +
        (hasBank
          ? '<label class="pay-opt' + (ONLINE_PAYMENT_ENABLED ? '' : ' on') + '" data-act="method" data-so="' + soId + '" data-kind="manual">' +
              '<input type="radio" name="paym-' + soId + '" value="manual"' + (ONLINE_PAYMENT_ENABLED ? '' : ' checked') + '/>' +
              '<span style="flex:1;min-width:0;">' +
                '<span class="pay-opt__label">Manual Bank Transfer</span>' +
                '<span class="pay-opt__desc">' + manualDesc + '</span>' +
              '</span>' +
            '</label>'
          : '<div class="pay-opt disabled">' +
              '<span style="flex:1;min-width:0;">' +
                '<span class="pay-opt__label">Manual Bank Transfer</span>' +
                '<span class="pay-opt__desc">' + manualDesc + '</span>' +
              '</span>' +
            '</div>') +
      '</div>' +

      /* Panel MANUAL — butir bank + borang bukti (macam manualTransferCard) */
      '<div class="pay-panel' + (ONLINE_PAYMENT_ENABLED ? '' : ' on') + '" id="panel-manual-' + soId + '">' +
        bankHtml +
        '<div class="g2">' +
          '<div class="f"><label class="lbl" for="pay-date-' + soId + '">Payment date</label>' +
            '<input type="date" id="pay-date-' + soId + '" value="' + new Date().toISOString().split('T')[0] + '"/></div>' +
          '<div class="f"><label class="lbl" for="pay-ref-' + soId + '">Bank transfer reference no. <span style="color:#C0392B;">*</span></label>' +
            '<input type="text" id="pay-ref-' + soId + '" placeholder="e.g. FPX20260410-12345"/></div>' +
        '</div>' +
        '<div class="f"><label class="lbl" for="pay-notes-' + soId + '">Notes (optional)</label>' +
          '<input type="text" id="pay-notes-' + soId + '" placeholder="e.g. First deposit"/></div>' +
        '<button type="button" class="upload-area" id="pay-upload-area-' + soId + '" data-act="upload" data-so="' + soId + '" style="width:100%;text-align:left;font:inherit;cursor:pointer;">' +
          '<div class="upload-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>' +
          '<div class="upload-txt" id="pay-upload-txt-' + soId + '">Upload payment proof <span style="color:#C0392B;">*</span></div>' +
          '<div class="upload-sub">JPG, PNG or PDF · Max 5MB</div>' +
        '</button>' +
        '<div class="info-ok" style="margin:12px 0 0;"><p>Your payment will be verified within 1–2 business days after submission.</p></div>' +
        '<div id="pay-form-err-' + soId + '" role="alert" style="display:none;font-size:11px;color:#C0392B;margin-top:8px;"></div>' +
        '<button class="btn btn-p" id="pay-submit-btn-' + soId + '" data-act="submit-manual" data-so="' + soId + '" style="width:100%;margin-top:10px;">Submit Manual Payment →</button>' +
      '</div>' +

      /* Panel ONLINE — disembunyikan default kalai Online dilumpuhkan */
      '<div class="pay-panel' + (ONLINE_PAYMENT_ENABLED ? ' on' : '') + '" id="panel-online-' + soId + '">' +
        '<div class="info-ok" style="margin:0 0 12px;"><p>You will be redirected to our secure payment page to complete this payment.</p></div>' +
        '<button class="btn btn-p" id="pay-online-submit-' + soId + '" data-act="submit-online" data-so="' + soId + '" style="width:100%;">Proceed to Payment →</button>' +
      '</div>' +
    '</div>'
  );
}


/* ══════════════════════════════════════════════
   INTERAKSI — event delegation (data-act)
   ══════════════════════════════════════════════ */

function bindBillingEvents(container) {
  container.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || !container.contains(el)) return;
    const act  = el.getAttribute('data-act');
    const soId = el.getAttribute('data-so') || '';
    const card = el.closest('.bill-so');

    if (act === 'toggle-so') {
      const open = !card.classList.contains('open');
      card.classList.toggle('open', open);
      el.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    else if (act === 'chip') {
      e.preventDefault();
      const input = document.getElementById('pay-amt-' + soId);
      if (input) { input.value = el.getAttribute('data-amt'); syncChips(soId, input.value); }
    }
    else if (act === 'method') {
      e.preventDefault();
      selectMethod(soId, el.getAttribute('data-kind'));
    }
    else if (act === 'upload')    { e.preventDefault(); triggerPayUpload(soId); }
    else if (act === 'submit-manual') { e.preventDefault(); submitSoPayment(soId); }
    else if (act === 'submit-online') { e.preventDefault(); submitOnlinePayment(soId); }
    else if (act === 'doc') {
      downloadDocument(el, el.getAttribute('data-doctype'), el.getAttribute('data-docname'));
    }
    else if (act === 'reload') { window.location.reload(); }
  });

  // Taip amount sendiri → tarik semula keadaan chip.
  container.addEventListener('input', e => {
    if (e.target.classList && e.target.classList.contains('pay-amount__input')) {
      const m = (e.target.id || '').match(/^pay-amt-(.+)$/);
      if (m) syncChips(m[1], e.target.value);
    }
  });
}

function syncChips(soId, val) {
  const v = parseFloat(val);
  document.querySelectorAll('.pay-chip[data-so="' + soId + '"]').forEach(ch => {
    const amt = parseFloat(ch.getAttribute('data-amt'));
    ch.classList.toggle('on', !isNaN(v) && Math.abs(v - amt) < 0.001);
  });
}

function selectMethod(soId, kind) {
  document.querySelectorAll('.pay-opt[data-so="' + soId + '"]').forEach(o => {
    const on = o.getAttribute('data-kind') === kind;
    o.classList.toggle('on', on);
    const radio = o.querySelector('input[type="radio"]');
    if (radio) radio.checked = on;
  });
  const manual = document.getElementById('panel-manual-' + soId);
  const online = document.getElementById('panel-online-' + soId);
  if (manual) manual.classList.toggle('on', kind === 'manual');
  if (online) online.classList.toggle('on', kind === 'online');
  hideBillingError('pay-err-' + soId);
}

function showBillingError(boxId, msg) {
  const box = document.getElementById(boxId);
  if (!box) { console.error(msg); return; }
  box.textContent = msg;
  box.style.display = 'block';
}
function hideBillingError(boxId) {
  const box = document.getElementById(boxId);
  if (box) box.style.display = 'none';
}


/* ══════════════════════════════════════════════
   ONLINE (Stripe checkout)
   ══════════════════════════════════════════════ */

async function submitOnlinePayment(soId) {
  const ctx  = SO_CTX[soId] || {};
  const err  = document.getElementById('pay-err-' + soId);
  const val  = parseFloat((document.getElementById('pay-amt-' + soId) || {}).value || 0);
  err.style.display = 'none';
  const showErr = m => { err.textContent = m; err.style.display = 'block'; };

  if (!val || val <= 0) { showErr('Please enter an amount.'); return; }
  if (val < ctx.min - 0.001) { showErr('Minimum is ' + ctx.symbol + ' ' + fmt(ctx.min) + '.'); return; }
  if (val > ctx.max + 0.001) { showErr('Maximum is ' + ctx.symbol + ' ' + fmt(ctx.max) + ' (balance).'); return; }

  const btn = document.getElementById('pay-online-submit-' + soId);
  btn.textContent = 'Redirecting...';
  btn.disabled = true;
  try {
    // return_to — bawa customer BALIK ke page ini selepas Stripe
    // (server saniti laluan; fallback transactions page kalau tidak sah).
    const result = await API_PM('create_payment_request', {
      sales_order: ctx.name, amount: val,
      return_to: window.location.pathname + window.location.search
    });
    if (result && result.payment_url) {
      window.location.href = result.payment_url;
    } else {
      showErr((result && result.message) || 'Payment link could not be generated.');
      btn.textContent = 'Proceed to Payment →';
      btn.disabled = false;
    }
  } catch (e) {
    showErr('Error: ' + (e.message || 'Please try again.'));
    btn.textContent = 'Proceed to Payment →';
    btn.disabled = false;
  }
}


/* ══════════════════════════════════════════════
   MANUAL TRANSFER — upload bukti
   ══════════════════════════════════════════════ */

function triggerPayUpload(soId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';
  input.onchange = e => {
    const file = e.target.files[0];
    const errEl = document.getElementById('pay-form-err-' + soId);
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      if (errEl) { errEl.textContent = 'File must be under 5MB — "' + file.name + '" is ' + (file.size / 1024 / 1024).toFixed(1) + 'MB.'; errEl.style.display = 'block'; }
      return;
    }
    if (errEl) errEl.style.display = 'none';
    _payFiles[soId] = file;
    document.getElementById('pay-upload-txt-' + soId).textContent = '✓ ' + file.name;
    document.getElementById('pay-upload-area-' + soId).style.borderColor = '#0F6E56';
  };
  input.click();
}

async function submitSoPayment(soId) {
  const ctx    = SO_CTX[soId] || {};
  const amount = parseFloat((document.getElementById('pay-amt-' + soId) || {}).value || 0);
  const date   = (document.getElementById('pay-date-' + soId) || {}).value || '';
  const ref    = ((document.getElementById('pay-ref-' + soId) || {}).value || '').trim();
  const notes  = ((document.getElementById('pay-notes-' + soId) || {}).value || '').trim();
  const err    = document.getElementById('pay-form-err-' + soId);

  err.style.display = 'none';
  const showErr = m => { err.textContent = m; err.style.display = 'block'; };

  if (!amount || amount <= 0) { showErr('Please enter the payment amount (use the amount box above).'); return; }
  if (amount > ctx.max + 0.001) { showErr('Amount exceeds the outstanding balance (' + ctx.symbol + ' ' + fmt(ctx.max) + ').'); return; }
  if (!date) { showErr('Please select the payment date.'); return; }
  if (!ref)  { showErr('Please enter your bank reference number.'); return; }
  if (!_payFiles[soId]) { showErr('Please upload your payment proof (receipt from your bank/transfer).'); return; }

  const btn = document.getElementById('pay-submit-btn-' + soId);
  btn.textContent = 'Submitting...';
  btn.disabled = true;

  try {
    const file = _payFiles[soId];
    const filedata = await new Promise(resolve => {
      const r = new FileReader();
      r.onload = e => resolve(e.target.result);
      r.readAsDataURL(file);
    });

    await API_PM('submit_manual_payment', {
      sales_order: ctx.name, amount,
      payment_date: date,
      reference_no: ref, notes, filedata, filename: file.name
    });

    delete _payFiles[soId];
    await loadBookingPayments();
    const notice = document.createElement('div');
    notice.className = 'info-ok';
    notice.setAttribute('role', 'status');
    notice.innerHTML = '<p>Payment proof received. Our team will verify it shortly — you will receive an email once confirmed.</p>';
    const sub = document.getElementById('billing-sub');
    sub.parentElement.insertBefore(notice, sub.nextSibling);
    notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    showErr(e.message || 'An error occurred. Please try again.');
  } finally {
    btn.textContent = 'Submit Manual Payment →';
    btn.disabled = false;
  }
}


/* ══════════════════════════════════════════════
   DOWNLOAD PDF — popup + fallback anchor
   ══════════════════════════════════════════════ */

async function downloadDocument(btn, doctype, docname) {
  const orig = btn.innerText.trim();
  btn.textContent = '...';
  btn.disabled = true;
  let win = null;
  try { win = window.open('', '_blank'); } catch (e) { /* popup blocked */ }
  if (win) win.document.write('<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>Generating document...</p></body></html>');
  try {
    const res = await fetch('/api/method/travel_booking.api.portal_payment.get_document_pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': _csrfToken() },
      credentials: 'include',
      body: JSON.stringify({ doctype, docname })
    });
    if (!res.ok) {
      if (win) win.close();
      btn.textContent = '✕ Not available';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
      return;
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    if (win) {
      win.location.href = blobUrl;
    } else {
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
    btn.textContent = '✕ Error';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
  } finally {
    if (btn.innerText.indexOf('✕') === -1) { btn.textContent = orig; btn.disabled = false; }
  }
}


/* ══════════════════════════════════════════════
   REDIRECT BALIK DARI STRIPE (payment_intent param)
   ══════════════════════════════════════════════ */

async function handleStripeReturn() {
  const params = new URLSearchParams(window.location.search);
  const pi = params.get('payment_intent');
  if (!pi) return;

  // Buang token Stripe dari address bar — kekalkan ?ref= supaya page
  // masih tahu booking mana yang dipapar (elak re-trigger bila refresh).
  const clean = new URLSearchParams();
  if (params.get('ref')) clean.set('ref', params.get('ref'));
  window.history.replaceState({}, document.title,
    window.location.pathname + (clean.toString() ? '?' + clean.toString() : ''));

  let result;
  try {
    result = await API_STRIPE('get_payment_result', { payment_intent: pi });
  } catch (e) {
    result = { status: 'unknown' };
  }

  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  if (result.status === 'succeeded') {
    box.className = 'info-ok';
    box.innerHTML = '<p>✓ Payment successful — ' +
      fmtDual(result.amount, result.currency || '') + ' received. The details below have been updated.</p>';
  } else if (result.status === 'processing') {
    box.className = 'info-ok';
    box.innerHTML = '<p>Payment is still processing. Your balance will be updated once it clears — you will also receive an email confirmation.</p>';
  } else {
    box.className = 'info-ok';
    box.style.background = '#FEE2E2';
    box.style.borderLeftColor = '#991B1B';
    box.innerHTML = '<p style="color:#991B1B;">' +
      (result.status === 'failed'
        ? 'Your payment could not be completed. No charge was made — please try again below.'
        : 'We could not confirm your payment status just now. It will appear here once processed — please check again shortly.') +
      '</p>';
  }

  const sub = document.getElementById('billing-sub');
  if (sub && sub.parentElement) sub.parentElement.insertBefore(box, sub.nextSibling);

  // Selepas bayaran direkodkan (atau gagal), muat semula data billing
  // supaya jumlah/baki/transaksi yang dipapar adalah terkini.
  await loadBookingPayments();
}


/* ══════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
  const ok = await ensureSession();
  if (!ok) return;
  renderNav();
  window.rcRefreshCurrency = renderBilling;

  BOOKING = _pageData.booking_ref || '';
  if (!BOOKING) return;
  await loadBookingPayments();
  await handleStripeReturn();
});
