/* ============================================================
   travel_booking/public/js/portal_billing.js
   Page: /traveller_portal/booking_billing?ref=...

   Port dari portal_payment.js (renderSoCard + loadBookingPayments),
   diadaptasikan untuk page berasingan + PENAMBAHAN:
   - Butang download PROFORMA per Sales Order (print format baharu)
   - Semua render di-escape guna _esc() (fix XSS — item name,
     reference_no dsb. tak boleh pecahkan layout/handler)
   - Manual transfer: inline errors + min/max hint (selari dgn online
     form — fix audit)
   - downloadDocument: fallback bila popup disekat (anchor download)
   - Upload receipt terima PDF (selain JPG/PNG)
   - Teks: "Deposit pertama"→"First deposit", "No. Bill"→"Orders"
   ============================================================ */

'use strict';

const _payFiles = {};
let BOOKING = '';

async function loadBookingPayments() {
  const container = document.getElementById('booking-pi-container');
  if (!container) return;

  container.innerHTML = '<div style="font-size:13px;color:#B0AC9F;padding:8px 0;">Loading...</div>';
  try {
    const data = await API_PM('get_all_so_payments', {});
    const allOrders = data.orders || [];
    const bookingOrders = allOrders.filter(so =>
      (so.booking_numbers || []).includes(BOOKING)
    );

    if (!bookingOrders.length) {
      container.innerHTML =
        '<div class="card" style="text-align:center;padding:32px 20px;font-size:13px;color:#7D7A70;">' +
        'No billing records for this booking yet. If you just made this booking, ' +
        'records will appear here shortly.</div>';
      return;
    }

    container.innerHTML =
      renderBookingOverview(bookingOrders) +
      bookingOrders.map(renderSoCard).join('');
  } catch (e) {
    container.innerHTML =
      '<div class="card" style="text-align:center;padding:32px 20px;">' +
        '<div style="font-size:13px;color:#991B1B;margin-bottom:14px;">' + _esc(e.message || 'Failed to load billing.') + '</div>' +
        '<button class="btn btn-g" onclick="window.location.reload()" style="font-size:12px;">Retry</button>' +
      '</div>';
  }
}

/* Ringkasan keseluruhan booking (Total/Paid/Balance + progress). */
function renderBookingOverview(orders) {
  const activeOrders = orders.filter(so => !so.is_cancelled);
  const grandTotal  = activeOrders.reduce((a, so) => a + parseFloat(so.grand_total || 0), 0);
  const totalPaid   = activeOrders.reduce((a, so) => a + parseFloat(so.advance_paid || 0), 0);
  const outstanding = Math.max(grandTotal - totalPaid, 0);
  const pct         = grandTotal > 0 ? Math.min((totalPaid / grandTotal) * 100, 100) : 0;
  const isPaid      = outstanding <= 0;
  const symbol      = (orders[0] && orders[0].currency_symbol) || 'RM'; // guardrail: semua SO satu booking satu currency

  return (
    '<div style="font-size:13px;color:#B0AC9F;margin-bottom:5px;text-align:right;line-height:1.1;">' +
      pct.toFixed(0) + '% <small>paid</small></div>' +
    '<div style="height:8px;background:#E7E3DA;border:1px solid #DFDFDF;border-radius:5px;overflow:hidden;">' +
      '<div style="height:100%;width:' + pct.toFixed(1) + '%;background:' + (isPaid ? '#0F6E56' : '#C9A84C') + ';border-radius:5px;"></div>' +
    '</div>' +

    '<div style="margin:20px 0 24px;">' +
      '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;border-radius:10px;border:1px solid #DFDFDF;overflow:hidden;">' +
        '<div style="padding:12px;">' +
          '<div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:#B0AC9F;margin-bottom:4px;">Orders</div>' +
          '<div style="font-size:16px;font-weight:500;color:#1E1C18;">' + orders.length + ' order' + (orders.length > 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div style="padding:12px;text-align:right;">' +
          '<div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:#B0AC9F;margin-bottom:4px;">Total Paid</div>' +
          '<div style="font-size:15px;font-weight:500;color:#0F6E56;">' + _esc(symbol) + ' ' + fmt(totalPaid) + '</div>' +
        '</div>' +
        '<div style="padding:12px;">' +
          '<div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:#B0AC9F;margin-bottom:4px;">Total Billed</div>' +
          '<div style="font-size:18px;font-weight:500;color:#1E1C18;">' + _esc(symbol) + ' ' + fmt(grandTotal) + '</div>' +
        '</div>' +
        '<div style="padding:12px;text-align:right;">' +
          '<div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:#B0AC9F;margin-bottom:4px;">Balance Due</div>' +
          '<div style="font-size:15px;font-weight:500;color:' + (isPaid ? '#0F6E56' : '#991B1B') + ';">' +
            (isPaid ? 'Paid ✓' : _esc(symbol) + ' ' + fmt(outstanding)) + '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

/* Kad SATU Sales Order — line items, payment history, invoices, proforma,
   butang bayar (online + manual). */
function renderSoCard(so) {
  const total       = parseFloat(so.grand_total || 0);
  const paid        = parseFloat(so.advance_paid || 0);
  const outstanding = Math.max(total - paid, 0);
  const pct         = total > 0 ? Math.min((paid / total) * 100, 100) : 0;
  const isPaid      = outstanding <= 0;
  const soId        = so.name.replace(/[^a-zA-Z0-9]/g, '-');
  const symbol      = so.currency_symbol || 'RM';
  const onlineMin   = paid <= 0 ? Math.round(total * 0.2 * 100) / 100 : 1;
  const onlineMax   = outstanding;
  const soNameEsc   = _esc(so.name);

  const payIcon = (color) =>
    '<div style="width:36px;height:36px;border-radius:10px;background:#E1F5EE;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
        '<rect x="1" y="4" width="14" height="10" rx="2" stroke="' + color + '" stroke-width="1.2"/>' +
        '<path d="M1 7h14" stroke="' + color + '" stroke-width="1.2"/>' +
        '<rect x="3" y="9.5" width="4" height="1.5" rx="0.5" fill="' + color + '"/>' +
      '</svg></div>';

  const historyHtml = (so.payments || []).length > 0
    ? (so.payments || []).map(p => {
        const isVerified  = p.status === 'Verified';
        const isCancelled = p.status === 'Cancelled';
        const sc = isVerified
          ? { bg: '#E1F5EE', color: '#085041', label: '✓ Verified' }
          : isCancelled
            ? { bg: '#FEE2E2', color: '#991B1B', label: '✕ Cancelled' }
            : { bg: '#F5F3EE', color: '#5C5850', label: 'Pending' };
        const icon = isVerified ? payIcon('#0F6E56') : payIcon('#888780');
        const pName = _esc(p.name);
        return (
          '<div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid #EAE7E0;">' +
            icon +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-size:13px;font-weight:500;color:#1E1C18;margin-bottom:2px;">' + _esc(p.mode_of_payment || 'Payment') + '</div>' +
              '<div style="font-size:12px;color:#7D7A70;">' + _esc(fmtDate(p.payment_date) || '-') + ' · Ref: ' + _esc(p.reference_no || '-') + '</div>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">' +
              '<div style="font-size:13px;font-weight:500;color:' + (isVerified ? '#0F6E56' : '#1E1C18') + ';">' + _esc(symbol) + ' ' + fmt(p.paid_amount) + '</div>' +
              '<div style="display:flex;align-items:center;gap:6px;">' +
                '<span style="font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;background:' + sc.bg + ';color:' + sc.color + ';">' + sc.label + '</span>' +
                (isVerified
                  ? '<button onclick="downloadDocument(this,\'Payment Entry\',\'' + pName + '\')" style="font-size:11px;font-weight:500;padding:4px 10px;border-radius:6px;border:1px solid #D3D1C7;background:transparent;color:#5C5850;cursor:pointer;">↓ Receipt</button>'
                  : '') +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }).join('')
    : '<div style="font-size:13px;color:#B0AC9F;padding:14px 0;">No payment records yet.</div>';

  const invoicesHtml = (so.invoices || []).length > 0
    ? '<div style="border-top:1px solid #EAE7E0;padding-top:16px;margin-top:16px;">' +
        '<div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:#7D7A70;margin-bottom:10px;">Invoices</div>' +
        (so.invoices || []).map(inv => {
          const invName = _esc(inv.name);
          return (
          '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;">' +
            '<div style="display:flex;align-items:center;gap:10px;min-width:0;">' +
              '<div style="width:32px;height:32px;border-radius:8px;background:#E6F1FB;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
                '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 2h7l3 3v9H3V2z" stroke="#185FA5" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="#185FA5" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 8h6M5 10.5h4" stroke="#185FA5" stroke-width="1.2" stroke-linecap="round"/></svg>' +
              '</div>' +
              '<div><div style="font-size:13px;font-weight:500;color:#1E1C18;font-family:monospace;">' + invName + '</div>' +
              '<div style="font-size:11px;color:#B0AC9F;margin-top:1px;">' + _esc(fmtDate(inv.posting_date) || '-') + ' · ' + _esc(symbol) + ' ' + fmt(inv.grand_total) + '</div></div>' +
            '</div>' +
            '<button onclick="downloadDocument(this,\'Sales Invoice\',\'' + invName + '\')" style="font-size:11px;font-weight:500;padding:4px 12px;border-radius:6px;border:1px solid #D3D1C7;background:transparent;color:#5C5850;cursor:pointer;flex-shrink:0;margin-left:12px;">↓ Invoice</button>' +
          '</div>'
          );
        }).join('') +
      '</div>'
    : '';

  const payButtonsHtml = !so.is_cancelled && !isPaid
    ? '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        '<button id="pay-online-btn-' + soId + '" onclick="toggleOnlineForm(\'' + soId + '\',this)" style="font-size:12px;padding:6px 14px;border-radius:6px;border:none;background:#0F6E56;color:#fff;cursor:pointer;font-weight:500;">Pay Now (Card)</button>' +
        '<button id="pay-manual-btn-' + soId + '" onclick="togglePayForm(\'' + soId + '\',this)" style="font-size:12px;padding:6px 14px;border-radius:6px;border:none;background:#C9A84C;color:#fff;cursor:pointer;font-weight:500;">Manual Transfer</button>' +
      '</div>'
    : '';

  const proformaBtn =
    '<button onclick="downloadDocument(this,\'Sales Order\',\'' + soNameEsc + '\')" style="font-size:11px;font-weight:500;padding:4px 12px;border-radius:6px;border:1px solid #D3D1C7;background:transparent;color:#5C5850;cursor:pointer;white-space:nowrap;">↓ Proforma</button>';

  const itemsHtml = (so.items || []).length > 0
    ? (so.items || []).map(item => {
        const amt = parseFloat(item.amount || 0);
        const isDiscount = amt < 0;
        const qty = parseFloat(item.qty || 1);
        const label = _esc((item.item_name || '')
          .replace(/\s*\(Cabin\s*\d+\)\s*/i, ' ')
          .replace(/\s*—\s*/g, ' · ')
          .replace(/\s{2,}/g, ' ')
          .trim());
        return (
          '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #EAE7E0;">' +
            '<div style="font-size:12px;color:' + (isDiscount ? '#0F6E56' : '#1E1C18') + ';">' + label +
            (qty > 1 ? ' <span style="color:#B0AC9F;">×' + qty.toFixed(0) + '</span>' : '') + '</div>' +
            '<div style="font-size:12px;font-weight:500;color:' + (isDiscount ? '#0F6E56' : '#1E1C18') + ';white-space:nowrap;padding-left:12px;">' +
              (isDiscount ? '-' : '') + _esc(symbol) + ' ' + fmt(Math.abs(amt)) + '</div>' +
          '</div>'
        );
      }).join('')
    : '';

  return (
    '<div style="background:#fff;border:1px solid #EAE7E0;border-radius:12px;margin-bottom:16px;overflow:hidden;">' +

      '<button type="button" onclick="toggleSoCard(\'' + soId + '\')" aria-expanded="false" style="width:100%;padding:16px 20px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px;background:none;border:none;font:inherit;text-align:left;">' +
        '<div style="min-width:0;">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
            '<div style="font-size:11px;color:#B0AC9F;">Bill Number</div>' +
            (so.is_cancelled ? '<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:#FEE2E2;color:#991B1B;">Cancelled</span>' : '') +
            proformaBtn +
          '</div>' +
          '<div style="font-size:14px;font-weight:500;font-family:monospace;color:#1E1C18;margin-top:2px;">' + soNameEsc + '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">' +
          '<div style="text-align:right;">' +
            '<div style="font-size:15px;font-weight:500;color:#1E1C18;">' + _esc(symbol) + ' ' + fmt(total) + '</div>' +
            '<span style="display:inline-block;margin-top:3px;font-size:10px;font-weight:500;padding:2px 8px;border-radius:20px;background:' + (isPaid ? '#E1F5EE' : '#FEF3C7') + ';color:' + (isPaid ? '#085041' : '#92400E') + ';">' + (isPaid ? 'Settled' : pct.toFixed(0) + '% paid') + '</span>' +
          '</div>' +
          '<svg id="so-chevron-' + soId + '" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="flex-shrink:0;transition:transform .2s;">' +
            '<path d="M4 6l4 4 4-4" stroke="#B0AC9F" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</div>' +
      '</button>' +

      '<div id="so-body-' + soId + '" style="display:none;padding:20px;background:#FFFEF5;border-top:1px solid #EFEFEF;">' +

        (itemsHtml
          ? '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:#7D7A70;margin-bottom:6px;">Line Items</div>' + itemsHtml +
            '<div style="display:flex;justify-content:space-between;align-items:center;padding-top:12px;margin-top:-1px;border-top:3px solid #D3D1C7;">' +
              '<div style="font-size:13px;font-weight:500;color:#1E1C18;">Total</div>' +
              '<div style="font-size:13px;font-weight:500;color:#C9A84C;">' + _esc(symbol) + ' ' + fmt(total) + '</div>' +
            '</div>'
          : '') +

        '<div style="display:flex;justify-content:space-between;align-items:center;padding:14px 0 4px;">' +
          '<div style="font-size:13px;font-weight:500;color:#5C5850;">Amount Paid</div>' +
          '<div style="font-size:15px;font-weight:600;color:#0F6E56;">' + _esc(symbol) + ' ' + fmt(paid) + '</div>' +
        '</div>' +
        (!isPaid && !so.is_cancelled
          ? '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;">' +
              '<div style="font-size:13px;font-weight:500;color:#5C5850;">Balance Due</div>' +
              '<div style="font-size:15px;font-weight:600;color:#92400E;">' + _esc(symbol) + ' ' + fmt(outstanding) + '</div>' +
            '</div>'
          : '') +

        invoicesHtml +

        '<div style="border-top:2px solid #EAE7E0;padding-top:16px;margin-top:16px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:10px;flex-wrap:wrap;">' +
            '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:#7D7A70;">Payment History</div>' +
            payButtonsHtml +
          '</div>' +
          historyHtml +

          /* Manual transfer form — kini dengan inline errors + hint (selari online form) */
          '<div id="pay-form-' + soId + '" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid #F0EDE7;">' +
            '<div class="g2">' +
              '<div class="f"><label class="lbl" for="pay-date-' + soId + '">Payment date</label>' +
                '<input type="date" id="pay-date-' + soId + '" value="' + new Date().toISOString().split('T')[0] + '"/></div>' +
              '<div class="f"><label class="lbl" for="pay-amount-' + soId + '">Amount (' + _esc(symbol) + ')</label>' +
                '<input type="number" id="pay-amount-' + soId + '" placeholder="0.00" step="0.01"/></div>' +
            '</div>' +
            '<div style="font-size:11px;color:#B0AC9F;margin:-6px 0 10px;">' +
              'Amount to transfer — full balance is ' + _esc(symbol) + ' ' + fmt(outstanding) + '.' +
            '</div>' +
            '<div class="f"><label class="lbl" for="pay-ref-' + soId + '">Reference no. (from your bank)</label>' +
              '<input type="text" id="pay-ref-' + soId + '" placeholder="e.g. FPX20260410-12345"/></div>' +
            '<div class="f"><label class="lbl" for="pay-notes-' + soId + '">Notes (optional)</label>' +
              '<input type="text" id="pay-notes-' + soId + '" placeholder="e.g. First deposit"/></div>' +
            '<button type="button" class="upload-area" id="pay-upload-area-' + soId + '" onclick="triggerPayUpload(\'' + soId + '\')" style="width:100%;text-align:left;font:inherit;cursor:pointer;">' +
              '<div class="upload-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>' +
              '<div class="upload-txt" id="pay-upload-txt-' + soId + '">Upload payment proof</div>' +
              '<div class="upload-sub">JPG, PNG or PDF · Max 5MB</div>' +
            '</button>' +
            '<div id="pay-form-err-' + soId + '" role="alert" style="display:none;font-size:11px;color:#C0392B;margin-top:8px;"></div>' +
            '<button class="btn btn-p" id="pay-submit-btn-' + soId + '" onclick="submitSoPayment(\'' + soId + '\',\'' + soNameEsc + '\')" style="width:100%;margin-top:10px;">Submit Manual Payment →</button>' +
          '</div>' +

          /* Online form */
          '<div id="pay-online-' + soId + '" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid #F0EDE7;">' +
            '<div class="f"><label class="lbl" for="pay-online-amount-' + soId + '">Amount to pay (' + _esc(symbol) + ')</label>' +
              '<input type="number" id="pay-online-amount-' + soId + '" placeholder="0.00" step="0.01" value="' + onlineMax.toFixed(2) + '"/></div>' +
            '<div style="font-size:11px;color:#B0AC9F;margin-top:4px;">' +
              'Min ' + _esc(symbol) + ' ' + fmt(onlineMin) + ' · Max ' + _esc(symbol) + ' ' + fmt(onlineMax) + ' (balance)' +
              (paid <= 0 ? ' · first payment must be at least the deposit' : '') + '</div>' +
            '<div id="pay-online-err-' + soId + '" role="alert" style="font-size:11px;color:#C0392B;margin-top:4px;display:none;"></div>' +
            '<button class="btn btn-p" id="pay-online-submit-' + soId + '" onclick="submitOnlinePayment(\'' + soId + '\',\'' + soNameEsc + '\',' + onlineMin + ',' + onlineMax + ')" style="width:100%;margin-top:10px;">Proceed to Payment →</button>' +
          '</div>' +

        '</div>' +
      '</div>' +
    '</div>'
  );
}

function toggleSoCard(soId) {
  const body = document.getElementById('so-body-' + soId);
  const chevron = document.getElementById('so-chevron-' + soId);
  const header = chevron ? chevron.closest('button') : null;
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
  if (header) header.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
}

function togglePayForm(soId, btn) {
  const wrap = document.getElementById('pay-form-' + soId);
  const open = wrap.style.display === 'none';
  wrap.style.display = open ? 'block' : 'none';
  btn.textContent = open ? '✕ Cancel' : 'Manual Transfer';
  btn.style.background = open ? '#F5F3EE' : '#C9A84C';
  btn.style.color = open ? '#5C5850' : '#fff';
}

function toggleOnlineForm(soId, btn) {
  const wrap = document.getElementById('pay-online-' + soId);
  const open = wrap.style.display === 'none';
  wrap.style.display = open ? 'block' : 'none';
  btn.textContent = open ? '✕ Cancel' : 'Pay Now (Card)';
  btn.style.background = open ? '#F5F3EE' : '#0F6E56';
  btn.style.color = open ? '#5C5850' : '#fff';
}

async function submitOnlinePayment(soId, soName, minAmt, maxAmt) {
  const err = document.getElementById('pay-online-err-' + soId);
  const val = parseFloat(document.getElementById('pay-online-amount-' + soId).value || 0);
  err.style.display = 'none';
  const showErr = m => { err.textContent = m; err.style.display = 'block'; };
  const symbol = 'RM';
  if (!val || val <= 0) { showErr('Please enter an amount.'); return; }
  if (val < minAmt - 0.001) { showErr('Minimum is ' + symbol + ' ' + fmt(minAmt) + '.'); return; }
  if (val > maxAmt + 0.001) { showErr('Maximum is ' + symbol + ' ' + fmt(maxAmt) + ' (balance).'); return; }

  const btn = document.getElementById('pay-online-submit-' + soId);
  btn.textContent = 'Redirecting...'; btn.disabled = true;
  try {
    const result = await API_PM('create_payment_request', { sales_order: soName, amount: val });
    if (result && result.payment_url) {
      window.location.href = result.payment_url;
    } else {
      showErr((result && result.message) || 'Payment link could not be generated.');
      btn.textContent = 'Proceed to Payment →'; btn.disabled = false;
    }
  } catch (e) {
    showErr('Error: ' + (e.message || 'Please try again.'));
    btn.textContent = 'Proceed to Payment →'; btn.disabled = false;
  }
}

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

async function submitSoPayment(soId, soName) {
  const amount = parseFloat(document.getElementById('pay-amount-' + soId).value || 0);
  const date   = document.getElementById('pay-date-' + soId).value;
  const ref    = (document.getElementById('pay-ref-' + soId).value || '').trim();
  const notes  = (document.getElementById('pay-notes-' + soId).value || '').trim();
  const err    = document.getElementById('pay-form-err-' + soId);

  err.style.display = 'none';
  const showErr = m => { err.textContent = m; err.style.display = 'block'; };

  // Inline validation (ganti alert chain) — selari dengan online form.
  if (!amount || amount <= 0) { showErr('Please enter the payment amount.'); return; }
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
      sales_order: soName, amount,
      payment_date: date,
      reference_no: ref, notes, filedata, filename: file.name
    });

    delete _payFiles[soId];
    // Refresh billing page — inline success notice (bukan alert).
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

/* Download PDF — dengan fallback bila popup disekat: anchor download
   dalam tab sama (fix audit: window.open null → senyap tiada apa). */
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
      alert('Document not available.');
      return;
    }
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    if (win) {
      win.location.href = blobUrl;
    } else {
      // Popup disekat — anchor download dalam tab sama.
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

document.addEventListener('DOMContentLoaded', async () => {
  const ok = await ensureSession();
  if (!ok) return;
  renderNav();

  BOOKING = _pageData.booking_ref || '';
  if (!BOOKING) return;
  await loadBookingPayments();
});
