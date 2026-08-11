/* ============================================================
   travel_booking/public/js/portal_payment.js
   Payment list, SO card, Submit payment, Download PDF
   ============================================================ */

const _payFiles = {};
let _allOrders  = [];

async function loadAllPayments() {
  const c = document.getElementById('so-list-container');

  // SENGAJA tiada cache — fetch fresh SETIAP KALI tab ni dibuka. Data
  // bayaran/booking boleh berubah bila-bila dari Desk (admin buat Payment
  // Entry, cipta Sales Invoice, dll) — customer patut SENTIASA nampak
  // keadaan terkini, bukan cache lama yang boleh tersangkut kalau
  // background-refresh (pendekatan lama) gagal senyap (.catch kosong,
  // tiada retry) — punca customer terpaksa logout/login semula untuk
  // nampak data terkini.
  if (c) c.innerHTML = '<div style="font-size:13px;color:#B0AC9F;padding:8px 0">Loading...</div>';
  try {
    const data = await API_PM('get_all_so_payments', {});
    _allOrders = data.orders || [];
    renderSoList(_allOrders);
  } catch (e) {
    console.error('loadAllPayments gagal:', e);
    if (c) c.innerHTML = `<div style="font-size:13px;color:#991B1B">${e.message}</div>`;
  }
}

function renderSoList(orders) {
  const container = document.getElementById('so-list-container');
  if (!container) return;
  document.getElementById('pi-list-view').style.display   = '';
  document.getElementById('pi-detail-view').style.display = 'none';

  // Flatten SEMUA payment + invoice merentasi semua SO jadi SATU senarai
  // transaksi individu (bukan kad per Sales Order) — sebab "Transactions"
  // patut tunjuk apa yang berlaku (bayaran diterima, invois dijana), bukan
  // status keseluruhan SO (yang dah dipapar dalam Trip Details > Payment &
  // Invoice untuk booking tertentu).
  const txns = [];

  orders.forEach(so => {
    const bookingLabel = (so.bookings || []).join(' · ') || so.name;
    // MULTI-CURRENCY: simbol currency SO ni sendiri (rujuk currency_symbol
    // dari get_all_so_payments() backend, sumber asal doctype Currency
    // ERPNext) — SETIAP transaksi papar simbol currency SO masing-masing,
    // bukan "RM" hardcode (booking boleh dalam MYR/SGD/BND berlainan).
    const soSymbol = so.currency_symbol || 'RM';

    (so.payments || []).forEach(p => {
      txns.push({
        type:        'payment',
        sortDate:    p.payment_date || '',
        title:       (p.mode_of_payment || 'Payment') +
                     (p.status === 'Pending' ? ' (pending review)' : ''),
        subtitle:    bookingLabel + ' · ' + so.name,
        amount:      parseFloat(p.paid_amount || 0),
        symbol:      soSymbol,
        statusLabel: p.status === 'Verified' ? 'Verified'
                   : p.status === 'Cancelled' ? 'Cancelled' : 'Pending',
        statusBg:    p.status === 'Verified' ? '#E1F5EE' : p.status === 'Cancelled' ? '#FEE2E2' : '#F5F3EE',
        statusColor: p.status === 'Verified' ? '#085041' : p.status === 'Cancelled' ? '#991B1B' : '#5C5850',
        onClick:     p.status === 'Verified'
                     ? `downloadDocument(this,'Payment Entry','${p.name}')` : null,
        actionLabel: p.status === 'Verified' ? 'Receipt' : null,
      });
    });

    (so.invoices || []).forEach(inv => {
      txns.push({
        type:        'invoice',
        sortDate:    inv.posting_date || '',
        title:       'Invoice ' + inv.name,
        subtitle:    bookingLabel + ' · ' + so.name,
        amount:      parseFloat(inv.grand_total || 0),
        symbol:      soSymbol,
        statusLabel: null,
        onClick:     `downloadDocument(this,'Sales Invoice','${inv.name}')`,
        actionLabel: 'Download',
      });
    });
  });

  if (!txns.length) {
    container.innerHTML = '<div class="card"><div style="font-size:13px;color:#B0AC9F">No transactions found yet.</div></div>';
    return;
  }

  // Terkini dulu
  txns.sort((a, b) => (b.sortDate || '').localeCompare(a.sortDate || ''));

  const paymentIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <rect x="1" y="4" width="14" height="10" rx="2" stroke="#0F6E56" stroke-width="1.2"/>
    <path d="M1 7h14" stroke="#0F6E56" stroke-width="1.2"/>
    <rect x="3" y="9.5" width="4" height="1.5" rx="0.5" fill="#0F6E56"/>
  </svg>`;
  const invoiceIcon = `<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
    <path d="M3 2h7l3 3v9H3V2z" stroke="#185FA5" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M10 2v3h3" stroke="#185FA5" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M5 8h6M5 10.5h4" stroke="#185FA5" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;

  container.innerHTML = txns.map(t => {
    const isPayment = t.type === 'payment';
    const iconBg    = isPayment ? '#E1F5EE' : '#E6F1FB';
    const icon      = isPayment ? paymentIcon : invoiceIcon;
    const amountColor = isPayment && t.statusLabel === 'Verified' ? '#0F6E56' : 'var(--color-text-primary,#1E1C18)';

    return `
      <div style="background:#fff;border:0.5px solid #EAE7E0;border-radius:12px;padding:16px 18px;margin-bottom:10px;display:flex;align-items:center;gap:14px">
        <div style="width:36px;height:36px;border-radius:10px;background:${iconBg};display:flex;align-items:center;justify-content:center;flex-shrink:0">${icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#1E1C18">${t.title}</div>
          <div style="font-size:12px;color:#B0AC9F;margin-top:2px">${t.subtitle}${t.sortDate ? ' · ' + t.sortDate : ''}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:14px;font-weight:600;color:${amountColor}">${t.symbol} ${t.amount.toLocaleString('en-MY', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
          <div style="margin-top:4px;display:flex;align-items:center;gap:6px;justify-content:flex-end">
            ${t.statusLabel ? `<span style="font-size:11px;font-weight:600;padding:2px 10px;border-radius:14px;background:${t.statusBg};color:${t.statusColor}">${t.statusLabel}</span>` : ''}
            ${t.onClick ? `<button onclick="${t.onClick}" style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:6px;border:0.5px solid #D3D1C7;background:transparent;color:#5C5850;cursor:pointer">${t.actionLabel}</button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

function showSoDetail(idx) {
  const so = _allOrders[idx];
  if (!so) return;
  document.getElementById('pi-list-view').style.display   = 'none';
  document.getElementById('pi-detail-view').style.display = '';
  document.getElementById('so-cards-container').innerHTML  = renderSoCard(so);

  const bc = document.getElementById('select-breadcrumb');
  if (bc) bc.innerHTML = `
    <span class="bc-link" onclick="showMainTab('bk', document.getElementById('main-tab-bk'))">My Bookings</span>
    <span class="bc-sep">›</span>
    <span class="bc-link" onclick="backToSoList()">Transactions</span>
    <span class="bc-sep">›</span>
    <span class="bc-current">${so.name}</span>`;
}

function backToSoList() {
  document.getElementById('pi-list-view').style.display   = '';
  document.getElementById('pi-detail-view').style.display = 'none';

  const bc = document.getElementById('select-breadcrumb');
  if (bc) bc.innerHTML = `
    <span class="bc-link" onclick="showMainTab('bk', document.getElementById('main-tab-bk'))">My Bookings</span>
    <span class="bc-sep">›</span>
    <span class="bc-current">Transactions</span>`;
}

// ══════════════════════════════════════════════
// PAYMENT & INVOICE — khusus SATU booking (tab dalam Trip Details)
// ══════════════════════════════════════════════
// Guna _allOrders yang sama (dari get_all_so_payments — semua SO customer,
// termasuk SO utama & addon setiap booking), tapi FILTER kepada booking yang
// sedang dibuka (variable global BOOKING, di-set oleh openPortal()). Ini
// elak panggilan API berasingan — reuse cache sedia ada.
async function loadBookingPayments() {
  const container = document.getElementById('booking-pi-container');
  const subEl      = document.getElementById('portal-pi-sub');
  if (!container) return;

  if (typeof BOOKING === 'undefined' || !BOOKING) {
    container.innerHTML = '<div class="card"><div style="font-size:13px;color:#B0AC9F">No booking selected.</div></div>';
    return;
  }

  if (subEl) subEl.textContent = BOOKING;

  // SENGAJA tiada cache — fetch fresh SETIAP KALI tab ni dibuka (sama
  // prinsip dengan loadAllPayments()). Data receipt/invois boleh berubah
  // bila-bila dari Desk — customer patut SENTIASA nampak keadaan terkini.
  const renderForBooking = (allOrders) => {
    const bookingOrders = allOrders.filter(so =>
      (so.booking_numbers || []).includes(BOOKING)
    );
    if (!bookingOrders.length) {
      container.innerHTML = '<div class="card"><div style="font-size:13px;color:#B0AC9F">No payment records for this booking yet.</div></div>';
      return;
    }
    container.innerHTML =
      renderBookingOverview(bookingOrders) +
      bookingOrders.map(so => renderSoCard(so)).join('');
  };

  container.innerHTML = '<div style="font-size:13px;color:#B0AC9F;padding:8px 0">Loading...</div>';
  try {
    const data = await API_PM('get_all_so_payments', {});
    _allOrders = data.orders || [];
    renderForBooking(_allOrders);
  } catch (e) {
    console.error('loadBookingPayments gagal:', e);
    container.innerHTML = `<div class="card"><div style="font-size:13px;color:#991B1B">${e.message}</div></div>`;
  }
}

// Ringkasan ATAS sahaja (Total/Paid/Balance keseluruhan booking) — untuk
// gambaran umum. TIADA butang bayar di sini; setiap SO di bawah ada butang
// bayar sendiri (renderSoCard). SO Cancelled dikecualikan dari kiraan
// (tapi tetap dipaparkan sebagai kad sendiri di bawah, dengan badge Cancelled).
function renderBookingOverview(orders) {
  const fmt = n => parseFloat(n || 0).toLocaleString('en-MY', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const activeOrders = orders.filter(so => !so.is_cancelled);

  const grandTotal  = activeOrders.reduce((a, so) => a + parseFloat(so.grand_total  || 0), 0);
  const totalPaid   = activeOrders.reduce((a, so) => a + parseFloat(so.advance_paid || 0), 0);
  const outstanding = Math.max(grandTotal - totalPaid, 0);
  const pct         = grandTotal > 0 ? Math.min((totalPaid / grandTotal) * 100, 100) : 0;
  const isPaid      = outstanding <= 0;
  // MULTI-CURRENCY: jumlah di atas SUM merentasi SEMUA SO untuk booking
  // (utama + addon) — ini SELAMAT sebab SEMUA SO untuk SATU booking WAJIB
  // currency yang sama (guardrail reka bentuk multi-currency, rujuk
  // dokumen reka bentuk Seksyen 3), jadi ambil symbol dari SO PERTAMA
  // sahaja sebagai wakil (semua SO dalam array ni sepatutnya currency
  // yang sama).
  const symbol = (orders[0] && orders[0].currency_symbol) || 'RM';

  // 
  // payment invoice dashboard total summmary per booking page
  //
  return `

    <div style="font-size:13px;color:var(--color-text-secondary,#B0AC9F);margin-bottom:5px;text-align:right; line-height:1.1; ">${pct.toFixed(0)}% <small>paid</small></div>
    <div style="height:8px;background:var(--color-background-secondary,#e7e3da); border:0.5px solid #dfdfdf; border-radius:5px; overflow:hidden; margin:0; ">
      <div style="height:100%;width:${pct.toFixed(1)}%;background:${isPaid ? '#0F6E56' : '#D4A312'};border-radius: 5px "></div>
    </div>

    <div style=" margin:25px 0px "> 
    
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px; border-radius:10px; border:0.5px solid #dfdfdf; overflow:hidden; margin:15px 0 0 0; ">

        <div style="padding:12px">
          <div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-secondary,#B0AC9F);margin-bottom:4px">No. Bill</div>
          <div style="font-size:16px;font-weight:500;color:var(--color-text-primary,#1E1C18)">${orders.length} order${orders.length > 1 ? 's' : ''}</div>
        </div>

        <div style="padding:12px; text-align:right;">
          <div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-secondary,#B0AC9F);margin-bottom:4px">Total Paid</div>
          <div style="font-size:15px;font-weight:500;color:#0F6E56">${symbol} ${fmt(totalPaid)}</div>
        </div>

        <div style="padding:12px;">
          <div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-secondary,#B0AC9F);margin-bottom:4px">Total Billed</div>
          <div style="font-size:18px;font-weight:500;color:var(--color-text-primary,#1E1C18)">${symbol} ${fmt(grandTotal)}</div>
        </div>
        
        <div style="padding:12px; text-align:right;">
          <div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-secondary,#B0AC9F);margin-bottom:4px">Balance due</div>
            <div style="font-size:15px;font-weight:500;color:${isPaid ? '#0F6E56' : '#991B1B'}">${isPaid ? 'Paid ✓' : symbol + ' ' + fmt(outstanding)}</div>
          </div>
        </div>

    </div>`;
}

// Kad SATU Sales Order sepenuhnya — Booking Order info, Line items, Payment
// history digabung dalam SATU pembungkus card (bukan 3 kad berasingan).
// Dipakai dalam tab Transactions (showSoDetail) DAN tab Payment & Invoice
// dalam Trip Details (loadBookingPayments), supaya setiap SO (utama atau
// addon) sentiasa dipapar + dibayar secara berasingan.
function renderSoCard(so) {
  const total       = parseFloat(so.grand_total  || 0);
  const paid        = parseFloat(so.advance_paid || 0);
  const outstanding = Math.max(total - paid, 0);
  const pct         = total > 0 ? Math.min((paid / total) * 100, 100) : 0;
  const isPaid      = outstanding <= 0;
  const soId        = so.name.replace(/[^a-zA-Z0-9]/g, '-');
  const fmt         = n => parseFloat(n || 0).toLocaleString('en-MY', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const onlineMin   = paid <= 0 ? Math.round(total * 0.2 * 100) / 100 : 1;
  const onlineMax   = outstanding;
  // MULTI-CURRENCY: symbol currency SO ni sendiri — rujuk get_all_so_payments()
  // backend (so.currency_symbol, sumber asal doctype Currency ERPNext).
  const symbol      = so.currency_symbol || 'RM';

  const cardIcon = `<div style="width:36px;height:36px;border-radius:10px;background:#E1F5EE;display:flex;align-items:center;justify-content:center;flex-shrink:0">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="4" width="14" height="10" rx="2" stroke="#0F6E56" stroke-width="1.2"/>
      <path d="M1 7h14" stroke="#0F6E56" stroke-width="1.2"/>
      <rect x="3" y="9.5" width="4" height="1.5" rx="0.5" fill="#0F6E56"/>
    </svg>
  </div>`;

  const historyHtml = (so.payments || []).length > 0
    ? (so.payments || []).map(p => {
        const isVerified  = p.status === 'Verified';
        const isCancelled = p.status === 'Cancelled';
        const sc = isVerified
          ? { bg: '#E1F5EE', color: '#085041', label: '✓ Verified' }
          : isCancelled
            ? { bg: '#FEE2E2', color: '#991B1B', label: '✕ Cancelled' }
            : { bg: '#F5F3EE', color: '#5C5850', label: 'Pending' };
        const icon = isVerified ? cardIcon
          : `<div style="width:36px;height:36px;border-radius:10px;background:var(--color-background-secondary,#F5F3EE);display:flex;align-items:center;justify-content:center;flex-shrink:0">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="4" width="14" height="10" rx="2" stroke="#888780" stroke-width="1.2"/>
                <path d="M1 7h14" stroke="#888780" stroke-width="1.2"/>
                <rect x="3" y="9.5" width="4" height="1.5" rx="0.5" fill="#888780"/>
              </svg>
            </div>`;
        return `
          <div style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:0.5px solid var(--color-border-tertiary,#EAE7E0)">
            ${icon}
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500;color:var(--color-text-primary,#1E1C18);margin-bottom:2px">${p.mode_of_payment || 'Payment'}</div>
              <div style="font-size:12px;color:var(--color-text-secondary,#7D7A70)">${p.payment_date || '-'} · Ref: ${p.reference_no || '-'}</div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0">
              <div style="font-size:13px;font-weight:500;color:${isVerified ? '#0F6E56' : 'var(--color-text-primary,#1E1C18)'}">${symbol} ${fmt(p.paid_amount)}</div>
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;background:${sc.bg};color:${sc.color}">${sc.label}</span>
                ${isVerified ? `<button onclick="downloadDocument(this,'Payment Entry','${p.name}')" style="font-size:11px;font-weight:500;padding:4px 10px;border-radius:6px;border:0.5px solid var(--color-border-secondary,#D3D1C7);background:transparent;color:var(--color-text-secondary,#5C5850);cursor:pointer">↓ Receipt</button>` : ''}
              </div>
            </div>
          </div>`;
      }).join('')
    : '<div style="font-size:13px;color:var(--color-text-secondary,#B0AC9F);padding:14px 0">No payment records yet.</div>';

  const invoicesHtml = (so.invoices || []).length > 0 ? `
    <div style="border-top:0px solid var(--color-border-tertiary,#EAE7E0);padding-top:16px;margin-top:16px">
      <div style="font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-secondary,#B0AC9F);margin-bottom:10px">Invoices</div>
      ${(so.invoices || []).map((inv, idx, arr) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;${idx < arr.length - 1 ? 'border-bottom:0.5px solid var(--color-border-tertiary,#EAE7E0)' : ''}">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:32px;height:32px;border-radius:8px;background:#E6F1FB;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M3 2h7l3 3v9H3V2z" stroke="#185FA5" stroke-width="1.2" stroke-linejoin="round"/>
              <path d="M10 2v3h3" stroke="#185FA5" stroke-width="1.2" stroke-linejoin="round"/>
              <path d="M5 8h6M5 10.5h4" stroke="#185FA5" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </div>
          <div>
            <div style="font-size:13px;font-weight:500;color:var(--color-text-primary,#1E1C18)">${inv.name}</div>
            <div style="font-size:11px;color:var(--color-text-tertiary,#B0AC9F);margin-top:1px">${inv.posting_date || '-'} · ${symbol} ${parseFloat(inv.grand_total || 0).toLocaleString('en-MY', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
          </div>
        </div>
        <button onclick="downloadDocument(this,'Sales Invoice','${inv.name}')"
                style="font-size:11px;font-weight:500;padding:4px 12px;border-radius:6px;border:0.5px solid var(--color-border-secondary,#D3D1C7);background:transparent;color:var(--color-text-secondary,#5C5850);cursor:pointer;flex-shrink:0;margin-left:12px">↓ Invoice</button>
      </div>`).join('')}
    </div>` : '';

  const payButtonsHtml = !isPaid ? `
    <div style="display:flex;gap:8px">
      <button id="pay-online-btn-${soId}" onclick="toggleOnlineForm('${soId}',this)"
              style="font-size:12px;padding:6px 14px;border-radius:6px;border:none;background:#0F6E56;color:#fff;cursor:pointer;font-weight:500">
        Pay Now (Card)
      </button>
      <button id="pay-manual-btn-${soId}" onclick="togglePayForm('${soId}','${so.name}',this)"
              style="font-size:12px;padding:6px 14px;border-radius:6px;border:none;background:#D4A312;color:#fff;cursor:pointer;font-weight:500">
        Manual Transfer
      </button>
    </div>` : '';

  return `
    <div style="background:var(--color-background-primary,#fff);border:0.5px solid var(--color-border-tertiary,#EAE7E0);border-radius:12px;margin-bottom:16px;overflow:hidden">

      <div onclick="toggleSoCard('${soId}')" style="padding:16px 20px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:12px">
        <div style="min-width:0">
          <div style="font-size:11px;color:var(--color-text-secondary,#B0AC9F);margin-bottom:3px">Bill Number</div>
          <div style="font-size:14px;font-weight:500;font-family:monospace;color:var(--color-text-primary,#1E1C18)">${so.name}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
          <div style="text-align:right">
            <div style="font-size:15px;font-weight:500;color:var(--color-text-primary,#1E1C18)">${symbol} ${fmt(total)}</div>
            <span style="display:inline-block;margin-top:3px;font-size:10px;font-weight:500;padding:2px 8px;border-radius:20px;background:${isPaid ? '#E1F5EE' : '#FEF3C7'};color:${isPaid ? '#085041' : '#92400E'}">${isPaid ? 'Settled' : pct.toFixed(0) + '% paid'}</span>
          </div>
          <svg id="so-chevron-${soId}" width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;transform:rotate(0deg);transition:transform .2s">
            <path d="M4 6l4 4 4-4" stroke="#B0AC9F" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>

      <div id="so-body-${soId}" style="display:none;padding:20px; background:#fffef5; border-top:1px solid #efefef;">

      ${(so.items || []).length > 0 ? `
      <div style="border-top:0.px solid var(--color-border-tertiary,#EAE7E0);">
        <div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-secondary,#7D7A70);margin-bottom:10px; font-size:smaller;">Line items</div>
        ${(so.items || []).map(item => {
          const amt        = parseFloat(item.amount || 0);
          const isDiscount = amt < 0;
          const qty        = parseFloat(item.qty || 1);
          // "Interior Cabin (Cabin 1) — Adult (Twin)" -> "Interior cabin · adult (twin)"
          const label = (item.item_name || '')
            .replace(/\s*\(Cabin\s*\d+\)\s*/i, ' ')
            .replace(/\s*—\s*/g, ' · ')
            .replace(/\s{2,}/g, ' ')
            .trim();
          return `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:0.5px solid var(--color-border-tertiary,#EAE7E0)">
              <div style="font-size:12px;color:${isDiscount ? '#0F6E56' : 'var(--color-text-primary,#1E1C18)'}">
                ${label}${qty > 1 ? ' <span style="color:var(--color-text-tertiary,#B0AC9F)">&times;' + qty.toFixed(0) + '</span>' : ''}
              </div>
              <div style="font-size:12px;font-weight:500;color:${isDiscount ? '#0F6E56' : 'var(--color-text-primary,#1E1C18)'};white-space:nowrap;padding-left:12px">
                ${isDiscount ? '-' : ''}${symbol} ${Math.abs(amt).toLocaleString('en-MY', {minimumFractionDigits:2, maximumFractionDigits:2})}
              </div>
            </div>`;
        }).join('')}
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:12px;margin-top:-1px;border-top:3px solid var(--color-border-secondary,#D3D1C7)">
          <div style="font-size:13px;font-weight:500;color:var(--color-text-primary,#1E1C18)">Total</div>
          <div style="font-size:13px;font-weight:500;color:#D4A312">${symbol} ${total.toLocaleString('en-MY', {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
        </div>
      </div>` : ''}
      
      
      <div style="font-size:15px;font-weight:500;color:#0F6E56">Amount Paid: ${symbol} ${fmt(paid)}</div>
      <div style="display:none; height:10px;background:var(--color-background-secondary,#F5F3EE);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${pct.toFixed(1)}%;background:${isPaid ? '#0F6E56' : '#D4A312'};border-radius:3px"></div>
      </div>

      ${invoicesHtml}

      <div style="border-top:2px solid var(--color-border-tertiary,#EAE7E0);padding-top:16px;margin-top:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-secondary,#7D7A70)">Payment history</div>
          ${payButtonsHtml}
        </div>
        ${historyHtml}
        <div id="pay-form-${soId}" style="display:none;margin-top:16px;padding-top:16px;border-top:0.5px solid var(--color-border-tertiary,#F0EDE7)">
          <div class="g2">
            <div class="f"><label class="lbl">Payment date</label>
              <input type="date" id="pay-date-${soId}" value="${new Date().toISOString().split('T')[0]}"/></div>
            <div class="f"><label class="lbl">Amount (${symbol})</label>
              <input type="number" id="pay-amount-${soId}" placeholder="0.00" step="0.01"/></div>
          </div>
          <div class="g2">
            <div class="f"><label class="lbl">Reference no.</label>
              <input type="text" id="pay-ref-${soId}" placeholder="e.g. FPX20260410-12345"/></div>
          </div>
          <div class="f"><label class="lbl">Notes (optional)</label>
            <input type="text" id="pay-notes-${soId}" placeholder="e.g. Deposit pertama"/></div>
          <div class="upload-area" id="pay-upload-area-${soId}" onclick="triggerPayUpload('${soId}')">
            <div class="upload-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>
            <div class="upload-txt" id="pay-upload-txt-${soId}">Upload payment proof</div>
            <div class="upload-sub">JPG, PNG · Max 5MB</div>
          </div>
          <button class="btn btn-p" id="pay-submit-btn-${soId}"
                  onclick="submitSoPayment('${soId}','${so.name}')"
                  style="width:100%;margin-top:10px">
            Submit Manual Payment →
          </button>
        </div>
        <div id="pay-online-${soId}" style="display:none;margin-top:16px;padding-top:16px;border-top:0.5px solid var(--color-border-tertiary,#F0EDE7)">
          <div class="f"><label class="lbl">Amount to pay (${symbol})</label>
            <input type="number" id="pay-online-amount-${soId}" placeholder="0.00" step="0.01" value="${onlineMax.toFixed(2)}"/></div>
          <div style="font-size:11px;color:var(--color-text-tertiary,#B0AC9F);margin-top:4px">
            Min ${symbol} ${fmt(onlineMin)} · Max ${symbol} ${fmt(onlineMax)} (balance)${paid <= 0 ? ' · first payment must be at least 20% deposit' : ''}
          </div>
          <div id="pay-online-err-${soId}" style="font-size:11px;color:#C0392B;margin-top:4px;display:none"></div>
          <button class="btn btn-p" id="pay-online-submit-${soId}"
                  onclick="submitOnlinePayment('${soId}','${so.name}',${onlineMin},${onlineMax},'${symbol}')"
                  style="width:100%;margin-top:10px">
            Proceed to Payment →
          </button>
        </div>
      </div>

      </div>
    </div>`;
}

function toggleSoCard(soId) {
  const body    = document.getElementById(`so-body-${soId}`);
  const chevron = document.getElementById(`so-chevron-${soId}`);
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  if (chevron) chevron.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
}

function togglePayForm(soId, soName, btn) {
  const wrap = document.getElementById(`pay-form-${soId}`);
  const open = wrap.style.display === 'none';
  wrap.style.display   = open ? 'block' : 'none';
  btn.textContent      = open ? '✕ Cancel' : 'Manual Transfer';
  btn.style.background = open ? 'var(--bg-secondary,#FAFAF8)' : '#D4A312';
  btn.style.color      = open ? 'var(--text-secondary,#5C5850)' : '#fff';
}

function toggleOnlineForm(soId, btn) {
  const wrap = document.getElementById(`pay-online-${soId}`);
  const open = wrap.style.display === 'none';
  wrap.style.display   = open ? 'block' : 'none';
  btn.textContent      = open ? '✕ Cancel' : 'Pay Now (Card)';
  btn.style.background  = open ? 'var(--bg-secondary,#FAFAF8)' : '#0F6E56';
  btn.style.color       = open ? 'var(--text-secondary,#5C5850)' : '#fff';
}

async function submitOnlinePayment(soId, soName, minAmt, maxAmt, symbol) {
  symbol = symbol || 'RM';
  const err = document.getElementById(`pay-online-err-${soId}`);
  const val = parseFloat(document.getElementById(`pay-online-amount-${soId}`).value || 0);
  err.style.display = 'none';
  const showErr = m => { err.textContent = m; err.style.display = 'block'; };
  if (!val || val <= 0)     { showErr('Please enter an amount.'); return; }
  if (val < minAmt - 0.001) { showErr(`Minimum is ${symbol} ${minAmt.toLocaleString('en-MY',{minimumFractionDigits:2, maximumFractionDigits:2})}.`); return; }
  if (val > maxAmt + 0.001) { showErr(`Maximum is ${symbol} ${maxAmt.toLocaleString('en-MY',{minimumFractionDigits:2, maximumFractionDigits:2})} (balance).`); return; }

  const btn = document.getElementById(`pay-online-submit-${soId}`);
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
    showErr('Error: ' + e.message);
    btn.textContent = 'Proceed to Payment →'; btn.disabled = false;
  }
}

function triggerPayUpload(soId) {
  const input  = document.createElement('input');
  input.type   = 'file';
  input.accept = '.jpg,.jpeg,.png';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('File must be under 5MB.'); return; }
    _payFiles[soId] = file;
    document.getElementById(`pay-upload-txt-${soId}`).textContent = `✓ ${file.name}`;
    document.getElementById(`pay-upload-area-${soId}`).style.borderColor = '#0F6E56';
  };
  input.click();
}

async function submitSoPayment(soId, soName) {
  const amount = document.getElementById(`pay-amount-${soId}`).value;
  const date   = document.getElementById(`pay-date-${soId}`).value;
  const ref    = document.getElementById(`pay-ref-${soId}`).value;
  const notes  = document.getElementById(`pay-notes-${soId}`).value;

  if (!amount || parseFloat(amount) <= 0) { alert('Please enter payment amount.'); return; }
  if (!date)   { alert('Please select payment date.'); return; }
  if (!ref)    { alert('Please enter reference number.'); return; }

  const btn = document.getElementById(`pay-submit-btn-${soId}`);
  btn.textContent = 'Submitting...';
  btn.disabled    = true;

  try {
    let filedata = '', filename = '';
    const file = _payFiles[soId];
    if (file) {
      filedata = await new Promise(resolve => {
        const r = new FileReader();
        r.onload = e => resolve(e.target.result);
        r.readAsDataURL(file);
      });
      filename = file.name;
    }

    const result = await API_PM('submit_manual_payment', {
      sales_order: soName, amount,
      payment_date: date,
      reference_no: ref, notes, filedata, filename
    });

    alert(result.message);
    delete _payFiles[soId];

    // Refresh ikut KONTEKS semasa — bukan sentiasa showSoDetail(), sebab
    // butang bayar ni dipakai dari 2 tempat berbeza: Transactions (detail
    // satu SO, guna showSoDetail) DAN Trip Details > Payment & Invoice
    // (kad gabungan semua SO, guna loadBookingPayments).
    const inBookingPi = document.getElementById('booking-pi-container')
      && document.getElementById('p-pi')
      && document.getElementById('p-pi').classList.contains('on');

    if (inBookingPi) {
      _allOrders = [];  // paksa refetch supaya data terkini (bukan cache lama)
      await loadBookingPayments();
    } else {
      await loadAllPayments();
      const newIdx = _allOrders.findIndex(o => o.name === soName);
      if (newIdx >= 0) showSoDetail(newIdx);
    }
  } catch (e) {
    alert(e.message || 'An error occurred.');
  } finally {
    btn.textContent = 'Submit Manual Payment →';
    btn.disabled    = false;
  }
}

async function downloadDocument(btn, doctype, docname) {
  const orig = btn.innerText.trim();
  btn.textContent = '...';
  btn.disabled    = true;
  const win = window.open('', '_blank');
  if (win) win.document.write('<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><p>Generating document...</p></body></html>');
  try {
    const res = await fetch('/api/method/travel_booking.api.portal_payment.get_document_pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': _csrfToken() },
      credentials: 'include',
      body: JSON.stringify({ doctype, docname })
    });
    if (!res.ok) { if (win) win.close(); alert('Document not available.'); return; }
    const blob    = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    if (win) win.location.href = blobUrl;
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
  } catch (e) {
    if (win) win.close();
    alert('Connection error: ' + (e.message || 'Please try again.'));
  } finally {
    btn.textContent = orig;
    btn.disabled    = false;
  }
}

// Butang bayar GABUNGAN (peringkat booking) DIBUANG — submitBookingPayment()
// dan submitBookingOnlinePayment() sebelum ini cuba agihkan SATU bayaran
// merentasi >1 Sales Order (waterfall allocation), yang menyebabkan sistem
// keliru menentukan SO/Payment Entry mana bila SO utama sudah settle tapi
// baki sebenar berada pada SO addon (throw "Payment Entry is already
// created"). Setiap Sales Order kini dipapar sebagai kad berasingan
// (renderSoCard) dengan butang bayar sendiri, guna submitSoPayment() dan
// submitOnlinePayment() — kedua-dua terikat terus kepada SATU SO sahaja.