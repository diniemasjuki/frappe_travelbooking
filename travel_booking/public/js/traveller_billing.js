/* ============================================================
   travel_booking/public/js/traveller_billing.js
   Billing page — SO cards (accordion), items, documents,
   transactions, and new payment form.
   Requires: traveller_common.js (loaded before this)
   ============================================================ */

'use strict';

(function () {
  var BOOKING_REF = _pageData.booking_ref || '';
  var allOrders = [];
  var _bankSettings = null; // cache for get_payment_settings() response

  /* ── Init ── */
  async function init() {
    if (!BOOKING_REF) return;
    try {
      await ensureSession();
      renderNav();
      await loadBilling();
    } catch (e) {
      console.error('Failed to load billing:', e);
    }
  }

  /* ── Load bank details from Travel Settings ── */
  async function loadBankSettings() {
    if (_bankSettings) return _bankSettings;
    try {
      // get_payment_settings is in pricing.py, not portal_payment.py
      var result = await _post('/api/method/travel_booking.api.pricing.get_payment_settings', {});
      if (result && result.bank_accounts) {
        _bankSettings = result;
      }
    } catch (e) {
      console.warn('Failed to load bank settings:', e);
    }
    return _bankSettings || {};
  }

  /* ── Populate bank table cells with live data ── */
  function populateBankTable(soName) {
    var currency = RC.company_currency || 'MYR';
    var banks = (_bankSettings && _bankSettings.bank_accounts) || {};
    var info = banks[currency] || {};

    var table = document.getElementById('bank-table-' + soName);
    if (!table) return;

    var nameEl = table.querySelector('.bank-name-el');
    var acctEl = table.querySelector('.bank-acct-el');
    var noEl   = table.querySelector('.bank-no-el');

    if (nameEl) nameEl.textContent = info.bank_name || '—';
    if (acctEl) acctEl.textContent = info.account_name || '—';
    if (noEl)   noEl.textContent = info.account_number || '—';

    // Hide bank section entirely if no data
    var wrapper = document.getElementById('bank-details-' + soName);
    if (wrapper && !info.bank_name && !info.account_name) {
      wrapper.style.display = 'none';
    }
  }

  /* ── Handle Stripe Payment Return (after redirect from checkout) ── */
  async function handleStripeReturn(paymentIntent) {
    var content = document.getElementById('billing-content');
    if (!content) return;

    // Show loading state while verifying
    content.style.display = 'block';
    content.innerHTML =
      '<div class="tv-card tv-text-center" style="padding:40px;">' +
      '<div style="font-size:32px;color:var(--c-gold);margin-bottom:12px;">⏳</div>' +
      '<p style="color:var(--text-muted);">Verifying payment...</p>' +
      '</div>';

    try {
      // Use Stripe API helper (same as checkout.js)
      var result = await _post('/api/method/travel_booking.api.stripe_checkout.get_payment_result', { payment_intent: paymentIntent });

      var status = (result && result.status) || 'unknown';
      var amount = (result && result.amount) || 0;
      var currency = (result && result.currency) || '';

      var cardHtml = '';
      if (status === 'succeeded') {
        cardHtml =
          '<div class="tv-card tv-animate-in" style="border-color:var(--c-success);border-width:2px;">' +
          '<div style="text-align:center;padding:32px 20px;">' +
          '<div style="font-size:48px;margin-bottom:12px;">✅</div>' +
          '<h3 style="margin:0 0 8px;color:var(--c-success);">Payment Successful!</h3>' +
          '<p style="font-size:18px;font-weight:700;color:var(--text-primary);margin:0 0 4px;">' + fmtDual(amount) + '</p>' +
          (currency ? '<p style="font-size:13px;color:var(--text-muted);margin:0;">Payment verified via Stripe</p>' : '') +
          '</div></div>';
      } else if (status === 'processing') {
        cardHtml =
          '<div class="tv-card tv-animate-in" style="border-color:var(--c-warning);border-width:2px;">' +
          '<div style="text-align:center;padding:32px 20px;">' +
          '<div style="font-size:48px;margin-bottom:12px;">⏳</div>' +
          '<h3 style="margin:0 0 8px;color:var(--c-warning);">Payment Processing</h3>' +
          '<p style="color:var(--text-secondary);margin:0;">Your payment is being confirmed. This may take a few minutes.</p>' +
          '<p style="font-size:12px;color:var(--text-muted);margin-top:12px;">Payment Intent: ' + _esc(paymentIntent) + '</p>' +
          '</div></div>';
      } else {
        cardHtml =
          '<div class="tv-card tv-animate-in" style="border-color:var(--c-danger-text);border-width:2px;">' +
          '<div style="text-align:center;padding:32px 20px;">' +
          '<div style="font-size:48px;margin-bottom:12px;">❌</div>' +
          '<h3 style="margin:0 0 8px;color:var(--c-danger-text);">Payment Failed</h3>' +
          '<p style="color:var(--text-secondary);margin:0 0 16px;">' + (result?.last_error || 'Could not complete payment. Please try again.') + '</p>' +
          '<a href="/traveller/billing?ref=' + encodeURIComponent(BOOKING_REF) + '" class="tv-btn tv-btn--primary tv-btn--sm" style="margin-top:16px;">← Try Again</a>' +
          '</div></div>';
      }

      // Store result for potential later use
      window._stripeResult = result;

      // Replace loading with result card
      content.innerHTML = cardHtml;

    } catch (e) {
      content.innerHTML =
        '<div class="tv-card tv-text-center" style="padding:40px;border:1px solid var(--c-danger-text);">' +
        '<p style="color:var(--c-danger-text);">Failed to verify payment: ' + _esc(e.message || 'Unknown error') + '</p>' +
        '<a href="/traveller/billing?ref=' + encodeURIComponent(BOOKING_REF) + '" class="tv-btn tv-btn--ghost tv-btn--sm" style="margin-top:16px;">← Back to Billing</a>' +
        '</div>';
    }
  }

  async function loadBilling() {
    var loading = document.getElementById('billing-loading');
    var content = document.getElementById('billing-content');

    // Check for ?bill= param (single-SO view from transactions page)
    var urlParams = new URLSearchParams(window.location.search);
    var targetBill = urlParams.get('bill') || '';

    // Check for ?payment_intent= (Stripe return redirect)
    var paymentIntent = urlParams.get('payment_intent') || '';
    if (paymentIntent) {
      await handleStripeReturn(paymentIntent);
      // Clean URL — remove payment_intent param
      urlParams.delete('payment_intent');
      var cleanUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
      window.history.replaceState({}, '', cleanUrl);
    }

    try {
      var data = await API_PM('get_all_so_payments', { booking_number: BOOKING_REF });
      allOrders = data.orders || [];

      // If ?bill= param present, filter to show only that specific SO
      if (targetBill) {
        allOrders = allOrders.filter(function (o) { return o.name === targetBill; });
        // Update data object so renderBilling uses filtered list
        data.orders = allOrders;
      }

      if (loading) loading.style.display = 'none';
      if (content) {
        content.style.display = 'block';

        // Load bank settings BEFORE render supaya renderPaymentFormCard
        // tahu sama ada Online Payment tersedia (payment gateway configured).
        await loadBankSettings();

        content.innerHTML = renderBilling(data, targetBill);
        wireDownloadButtons();
        wirePaymentForms();

        // Populate bank table cells with live data
        var so0 = allOrders[0];
        if (so0) populateBankTable(so0.name);
      }
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (content) {
        content.style.display = 'block';
        content.innerHTML =
          '<div class="tv-card tv-text-center" style="padding:40px;">' +
          '<p style="color:var(--c-danger-text);">' + _esc(e.message || 'Failed to load billing.') + '</p>' +
          '<a href="/traveller/booking?ref=' + encodeURIComponent(BOOKING_REF) + '" class="tv-btn tv-btn--ghost tv-btn--sm" style="margin-top:16px;">← Back to Booking</a>' +
          '</div>';
      }
    }
  }

  /* ══════════════════════════════════════════════════
     RENDER BILLING PAGE — Single Sales Order Detail View
     4 sequential cards: Billing Info → Items → Transactions → Payment
     ══════════════════════════════════════════════════ */

  function renderBilling(data, targetBill) {
    var orders = data.orders || [];
    targetBill = targetBill || '';

    // Extract single SO
    var so = null;
    if (targetBill) {
      so = orders.find(function (o) { return o.name === targetBill; });
    } else {
      so = orders[0] || null; // fallback: first SO
    }

    if (!so) {
      return '<div class="tv-empty"><div class="tv-empty__icon">💳</div>' +
             '<h3 class="tv-empty__title">No Billing Data</h3>' +
             '<p class="tv-empty__desc">' + (targetBill ? 'Sales Order <strong>' + _esc(targetBill) + '</strong> not found or no access.' : 'No sales orders found for this booking.') + '</p>' +
             '<a href="/traveller/booking?ref=' + encodeURIComponent(BOOKING_REF) + '" class="tv-btn tv-btn--ghost tv-btn--sm" style="margin-top:12px;">← Back to Booking</a></div>';
    }

    var html = '';
    var backLink = '<a href="/traveller/booking?ref=' + encodeURIComponent(BOOKING_REF) + '" class="tv-btn tv-btn--ghost tv-btn--sm" style="text-decoration:none;">← Back to Booking</a>';

    // Back link — TOP (before content)
    html += '<div style="margin-bottom:16px;">' + backLink + '</div>';

    // Card 1: Billing Information (full width)
    html += renderBillingInfo(so);

    // Card 2: Items List (full width)
    html += renderItemsCard(so);

    // Cards 3+4: Transactions (2/3) + Payment Form (1/3) side by side
    var paymentCard = renderPaymentFormCard(so);
    if (paymentCard) {
      // Only show 2-col layout if payment card has content (not cancelled)
      html += '<div class="tv-billing-grid" style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;">';
      html += '<div style="flex:2;min-width:0;">'; // Transactions — 2/3 width
      html += renderTransactionsCard(so);
      html += '</div>';
      html += '<div style="flex:1;min-width:280px;">'; // Payment — 1/3 width
      html += paymentCard;
      html += '</div>';
      html += '</div>'; // grid wrapper
    } else {
      // Cancelled SO — show transactions full width, no payment card
      html += renderTransactionsCard(so);
    }

    // Back link — BOTTOM (after content)
    html += '<div style="margin-top:24px;text-align:center;">' + backLink + '</div>';

    return html;
  }

  /* ── Card 1: Billing Information ── */
  function renderBillingInfo(so) {
    var name = _esc(so.name || '');
    var grandTotal = parseFloat(so.grand_total) || 0;
    var advancePaid = parseFloat(so.advance_paid) || 0;
    var balance = grandTotal - advancePaid;
    var payPct = grandTotal > 0 ? Math.round((advancePaid / grandTotal) * 100) : 0;
    var isSettled = balance <= 0;
    var isCancelled = so.is_cancelled;

    var statusLabel = isCancelled ? 'Cancelled' : (isSettled ? 'Fully Settled' : payPct + '% paid');
    var statusCls = isCancelled ? 'danger' : (isSettled ? 'success' : 'warning');

    var html = '';
    html += '<div class="tv-card tv-animate-in">';
    // Header: title + SO name
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:12px;">';
    html += '<h3 class="tv-card__title" style="margin:0;">📋 Billing</h3>';
    html += '<span style="font-family:\'SF Mono\',Monaco,monospace;font-size:14px;font-weight:600;color:var(--c-gold-dark);">' + name + '</span>';
    html += '</div>';

    // Progress bar
    html += '<div class="tv-progress" role="progressbar" aria-valuenow="' + payPct + '" aria-valuemin="0" aria-valuemax="100">';
    html += '<div class="tv-progress__fill' + (isSettled ? ' done' : '') + '" style="width:' + payPct + '%"></div>';
    html += '</div>';

    // Progress label
    html += '<div class="tv-progress-label" style="justify-content:center;margin-bottom:16px;">';
    if (isSettled && !isCancelled) {
      html += '<span class="tv-progress-label--success">✓ Fully Settled — thank you!</span>';
    } else if (isCancelled) {
      html += '<span class="tv-badge tv-badge--' + statusCls + '">' + statusLabel + '</span>';
    } else {
      html += '<span>' + fmtDual(balance) + ' remaining to settle</span>';
    }
    html += '</div>';

    // 3-column totals grid
    html += '<div class="tv-hero-grid" style="margin-bottom:16px;">';
    html += '<div class="tv-hero-cell"><div class="tv-hero-label">Total Amount</div><div class="tv-hero-value" style="font-family:var(--font-heading);font-weight:700;">' + fmtDual(grandTotal) + '</div></div>';
    html += '<div class="tv-hero-cell"><div class="tv-hero-label">Total Paid</div><div class="tv-hero-value tv-bk-fin-value--success" style="font-family:var(--font-heading);font-weight:700;">' + fmtDual(advancePaid) + '</div></div>';
    html += '<div class="tv-hero-cell"><div class="tv-hero-label">Balance Due</div><div class="tv-hero-value ' + (isSettled ? 'tv-bk-fin-value--success' : 'tv-bk-fin-value--warning') + '" style="font-family:var(--font-heading);font-weight:700;">' + fmtDual(balance) + '</div></div>';
    html += '</div>'; // grid

    // Additional info row
    html += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding-top:12px;font-size:13px;color:var(--text-muted);">';
    // Status badge
    if (!isSettled || isCancelled) {
      html += '<span>Status: <span class="tv-badge tv-badge--' + statusCls + '">' + statusLabel + '</span></span>';
    } else {
      html += '<span>Status: <span class="tv-badge tv-badge--success">' + statusLabel + '</span></span>';
    }
    // Date & currency
    if (so.transaction_date) {
      html += '<span>Date: ' + fmtDate(so.transaction_date) + '</span>';
    }
    if (so.currency_symbol) {
      html += '<span>Currency: ' + _esc(so.currency_symbol) + '</span>';
    }
    html += '</div>';

    html += '</div>'; // card
    return html;
  }

  /* ── Card 2: Items List ── */
  function renderItemsCard(so) {
    var items = so.items || [];
    var grandTotal = parseFloat(so.grand_total) || 0;

    var html = '';
    html += '<div class="tv-card tv-animate-in">';
    html += '<div class="tv-sec">📦 Items</div>';

    if (items.length > 0) {
      html += '<table class="tv-table">';
      html += '<thead><tr><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>';
      items.forEach(function (item) {
        var amount = (parseFloat(item.qty) || 0) * (parseFloat(item.rate) || 0);
        // Item name (primary) + full description below (secondary) — ERPNext
        // descriptions contain HTML, strip tags & decode entities first.
        var desc = _stripHtml(item.description || '');
        html += '<tr>';
        html += '<td>';
        html += '<div style="font-weight:600;">' + _esc(item.item_name || '-') + '</div>';
        if (desc && desc !== item.item_name) {
          html += '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;white-space:pre-line;">' + _esc(desc) + '</div>';
        }
        html += '</td>';
        html += '<td>' + (item.qty || 1) + '</td>';
        html += '<td>' + fmtDual(item.rate) + '</td>';
        html += '<td>' + fmtDual(amount) + '</td>';
        html += '</tr>';
      });
      // Grand Total row
      html += '<tr style="background:var(--bg-secondary);">';
      html += '<td colspan="3" style="text-align:right;font-weight:600;">Grand Total</td>';
      html += '<td style="font-weight:700;">' + fmtDual(grandTotal) + '</td>';
      html += '</tr>';
      html += '</tbody></table>';
    } else {
      html += '<p style="font-size:13px;color:var(--text-muted);padding:12px 0;">No items found.</p>';
    }

    html += '</div>'; // card
    return html;
  }

  /* ── Card 3: Transaction List ── */
  function renderTransactionsCard(so) {
    var payments = so.payments || [];

    var html = '';
    html += '<div class="tv-card tv-animate-in">';
    html += '<div class="tv-sec">💳 Transactions</div>';

    if (payments.length > 0) {
      payments.forEach(function (pay) {
        var txStatus = _esc(pay.status || 'Pending');
        var txCls = txStatus === 'Verified' ? 'success' : (txStatus === 'Cancelled' ? 'danger' : 'warning');
        var channelLabel = _esc(pay.channel_label || pay.channel || 'Online Payment');
        var iconClass = (pay.channel === 'online') ? 'online' : 'bank';

        html += '<div class="tv-tx-item">';
        html += '<div class="tv-tx-icon tv-tx-icon--' + iconClass + '">';
        html += (pay.channel === 'online') ? '💳' : '🏦';
        html += '</div>';
        html += '<div class="tv-tx-details">';
        html += '<div class="tv-tx-date">' + (pay.payment_date ? fmtDate(pay.payment_date) : '') + '</div>';
        html += '<div class="tv-tx-desc">' + channelLabel + ' · ' + fmtDual(pay.paid_amount) + '</div>';
        if (pay.reference_no) {
          html += '<div class="tv-tx-meta">Ref: ' + _esc(pay.reference_no) + '</div>';
        }
        html += '</div>'; // details
        html += '<div class="tv-tx-actions">';
        html += '<span class="tv-badge tv-badge--' + txCls + '">' + txStatus + '</span>';
        if (txStatus === 'Verified') {
          html += '<button class="tv-btn tv-btn--ghost tv-btn--sm" data-act="download-receipt" data-name="' + _esc(pay.name) + '">📥 Receipt</button>';
        }
        html += '</div>'; // actions
        html += '</div>'; // tx-item
      });
    } else {
      html += '<p style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">No transactions yet.</p>';
    }

    html += '</div>'; // card
    return html;
  }

  /* ── Card 4: Payment Form (or settled/cancelled message) ── */
  function renderPaymentFormCard(so) {
    var name = _esc(so.name || '');
    var grandTotal = parseFloat(so.grand_total) || 0;
    var advancePaid = parseFloat(so.advance_paid) || 0;
    var balance = grandTotal - advancePaid;
    var isSettled = balance <= 0;
    var isCancelled = so.is_cancelled;

    var html = '';

    if (isCancelled) {
      // Cancelled — no card rendered
      return '';
    }

    html += '<div class="tv-card tv-animate-in">';

    if (!isSettled) {
      // Payment form needed
      html += renderPaymentForm(name, grandTotal, advancePaid);
    } else {
      // Fully settled message
      html += '<div style="padding:24px;text-align:center;background:var(--c-success-bg);border-radius:8px;">';
      html += '<span style="font-size:28px;">✅</span>';
      html += '<p style="margin:10px 0 0;color:var(--c-success-text);font-weight:600;font-size:15px;">This order is fully settled.</p>';
      html += '<p style="margin:6px 0 0;color:var(--text-muted);font-size:13px;">Thank you for your payment!</p>';
      html += '</div>';

      // Invoice downloads — fully paid, user needs the Sales Invoice
      var invoices = so.invoices || [];
      if (invoices.length > 0) {
        html += '<div class="tv-sec">📄 Sales Invoice</div>';
        invoices.forEach(function (inv) {
          html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--border-light);">';
          html += '<div style="min-width:0;">';
          html += '<div style="font-size:13px;font-weight:600;color:var(--text-primary);">' + _esc(inv.name) + '</div>';
          html += '<div style="font-size:12px;color:var(--text-muted);">' + (inv.posting_date ? fmtDate(inv.posting_date) : '') + ' · ' + fmtDual(inv.grand_total) + '</div>';
          html += '</div>';
          html += '<div style="display:flex;gap:6px;flex-shrink:0;">';
          html += '<button class="tv-btn tv-btn--ghost tv-btn--sm" title="Download PDF" data-act="download-doc" data-type="invoice" data-name="' + _esc(inv.name) + '">📥 Download</button>';
          html += '</div>';
          html += '</div>';
        });
      } else {
        html += '<p style="font-size:13px;color:var(--text-muted);text-align:center;margin-top:12px;">Sales invoice will appear here once issued.</p>';
      }
    }

    html += '</div>'; // card
    return html;
  }

  /* ── Payment Form Section ── */
  function renderPaymentForm(soName, grandTotal, alreadyPaid) {
    var outstanding = Math.round((grandTotal - alreadyPaid) * 100) / 100;

    var html = '';
    html += '<div class="tv-sec tv-pay-form">💵 Make a Payment</div>';

    // Inline alert bar (validation errors appear here, right after title)
    html += '<div class="tv-msg tv-msg--error pay-inline-error" role="alert" style="display:none;margin-bottom:16px;"></div>';

    html += '<form id="pay-form-' + _esc(soName) + '" data-so="' + _esc(soName) + '" autocomplete="off">';

    // Amount input — min 0.01 (method-specific minimums enforced in JS handlers)
    html += '<div class="tv-form-group">';
    html += '<label class="tv-label">Payment Amount (' + _esc(RC.company_symbol || 'RM') + ')</label>';
    html += '<input type="number" class="tv-input pay-amount-input" min="0.01" step="0.01" max="' + outstanding + '" placeholder="Enter amount"/>';
    var minHint = outstanding < 2.00
      ? 'Max: ' + fmtDual(outstanding) + ' · Online payment unavailable below RM 2.00 — please use Manual Bank Transfer'
      : 'Min: RM 2.00 (online) · Max: ' + fmtDual(outstanding);
    html += '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + minHint + '</div>';
    html += '</div>';

    // Quick chips — 2-column layout
    var depositPct = parseInt(_bankSettings && _bankSettings.default_deposit_percent) || 20;
    html += '<div class="tv-pay-chips" style="display:flex;gap:12px;">';
    html += '<button type="button" class="tv-pay-chip" data-pct="' + depositPct + '" style="flex:0.4;">Deposit<br/><span style="font-size:11px;">(' + depositPct + '%)</span></button>';
    html += '<button type="button" class="tv-pay-chip" data-pct="100" style="flex:0.6;">Full Balance<br/><span style="font-size:11px;">' + fmtDual(outstanding) + '</span></button>';
    html += '</div>';

    // Method selection — Online Payment hanya dipaparkan kalau payment
    // gateway diconfigure di Travel Settings. Kalau tiada, default ke Manual.
    var onlineEnabled = _bankSettings && _bankSettings.online_payment_enabled !== false;

    html += '<div class="tv-pay-methods">';
    if (onlineEnabled) {
      html += '<label class="tv-pay-method selected" data-method="online">';
      html += '<input type="radio" name="pay-method-' + _esc(soName) + '" value="online" checked class="tv-pay-radio"/>';
      html += '<span>💳 Online Payment (Stripe)</span>';
      html += '</label>';
    } else {
      html += '<div class="tv-pay-method" style="opacity:0.5;cursor:not-allowed;pointer-events:none;">';
      html += '<span>💳 Online Payment — not available</span>';
      html += '</div>';
    }
    html += '<label class="tv-pay-method' + (onlineEnabled ? '' : ' selected') + '" data-method="manual">';
    html += '<input type="radio" name="pay-method-' + _esc(soName) + '" value="manual"' + (onlineEnabled ? '' : ' checked') + ' class="tv-pay-radio"/>';
    html += '<span>🏦 Manual Bank Transfer</span>';
    html += '</label>';
    html += '</div>';

    // Online panel — sembunyi default kalau Online dilumpuhkan
    html += '<div class="tv-pay-panel' + (onlineEnabled ? ' on' : '') + '" id="panel-online-' + _esc(soName) + '">';
    html += '<p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">You will be redirected to Stripe secure checkout to complete your payment.</p>';
    html += '<button type="submit" class="tv-btn tv-btn--primary" style="width:100%;" data-act="pay-online">Proceed to Payment →</button>';
    html += '</div>';

    // Manual transfer panel — papar default kalau Online dilumpuhkan
    html += '<div class="tv-pay-panel' + (onlineEnabled ? '' : ' on') + '" id="panel-manual-' + _esc(soName) + '">';
    // Bank details table (populated dynamically after API load)
    html += '<div style="margin-bottom:16px;" id="bank-details-' + _esc(soName) + '">';
    html += '<p style="font-size:12px;font-weight:600;color:var(--text-secondary);margin-bottom:8px;">Bank Details:</p>';
    html += '<table class="tv-bank-table" id="bank-table-' + _esc(soName) + '">';
    html += '<tr><td>Bank</td><td class="bank-name-el">Loading...</td></tr>';
    html += '<tr><td>Account Name</td><td class="bank-acct-el">Loading...</td></tr>';
    html += '<tr><td>Account Number</td><td class="bank-no-el">Loading...</td></tr>';
    html += '</table>';
    html += '</div>';

    // File upload (moved before date/ref)
    html += '<div class="tv-form-group">';
    html += '<label class="tv-label">Upload Proof of Payment</label>';
    html += '<div class="tv-file-upload" id="file-upload-' + _esc(soName) + '">';
    html += '<div class="tv-file-upload__icon">📎</div>';
    html += '<div class="tv-file-upload__text">Click or drag file here</div>';
    html += '<div class="tv-file-upload__hint">JPG, PNG, PDF · Max 5MB</div>';
    html += '<input type="file" accept=".jpg,.jpeg,.png,.pdf" class="pay-file-input" style="display:none;"/>';
    html += '</div>';
    html += '</div>';

    // Transfer Date — full width
    html += '<div class="tv-form-group">';
    html += '<label class="tv-label">Transfer Date</label>';
    html += '<input type="date" class="tv-input pay-date"/>';
    html += '</div>';

    // Reference No. — full width
    html += '<div class="tv-form-group">';
    html += '<label class="tv-label">Reference No.</label>';
    html += '<input type="text" class="tv-input pay-ref-no" placeholder="Bank transaction reference"/>';
    html += '</div>';

    // Notes
    html += '<div class="tv-form-group">';
    html += '<label class="tv-label">Notes (optional)</label>';
    html += '<textarea class="tv-input pay-notes" rows="2" placeholder="Any additional notes..."></textarea>';
    html += '</div>';

    html += '<button type="submit" class="tv-btn tv-btn--primary" style="width:100%;margin-top:12px;" data-act="pay-manual">Submit Payment Proof</button>';
    html += '</div>'; // manual panel

    html += '</form>'; // form
    return html;
  }

  /* ══════════════════════════════════════════════════
     RECEIPT OCR — Extract text from uploaded bank slip
     Auto-fill: Reference No, Transfer Date, Notes field
     ══════════════════════════════════════════════════ */

  var _ocrWorker = null; // Tesseract worker (lazy init)

  /* Lazy-initialize Tesseract worker */
  async function initReceiptOCR() {
    if (_ocrWorker) return _ocrWorker;
    if (typeof Tesseract === 'undefined') {
      console.warn('Tesseract.js not loaded — OCR unavailable');
      return null;
    }
    try {
      _ocrWorker = await Tesseract.createWorker('eng', 1, {
        logger: function (m) {
          if (m.status === 'recognizing text') {
            var pct = Math.round(m.progress * 100);
            var el = document.querySelector('.tv-file-upload__hint');
            if (el) el.textContent = 'Reading receipt... ' + pct + '%';
          }
        }
      });
    } catch (e) {
      console.warn('Failed to init Tesseract:', e);
      _ocrWorker = null;
    }
    return _ocrWorker;
  }

  /* Parse Malaysian bank slip text for date & reference number */
  function parseBankSlip(text) {
    if (!text) return { date: null, reference: null, rawText: '' };
    var clean = text.replace(/\s+/g, ' ').trim();
    var date = null, reference = null;

    // Date patterns — DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (European), D MMM YYYY
    var datePatterns = [
      /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,                    // 23/08/2026
      /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})/,                      // 23/08/26 → assume 20xx
      /(\d{1,2})\.(\d{1,2})\.(\d{4})/,                              // 23.08.2026 (European)
      /(\d{1,2})\.(\d{1,2})\.(\d{2})/,                                // 23.08.26 (European)
      /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i  // 23 Aug 2026
    ];
    var months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                 jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};

    for (var i = 0; i < datePatterns.length; i++) {
      var m = clean.match(datePatterns[i]);
      if (m) {
        if (m[2].length === 3) {
          date = m[3] + '-' + months[m[2].toLowerCase()] + '-' + m[1].padStart(2,'0');
        } else if (m[3].length === 2) {
          date = '20' + m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
        } else {
          date = m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
        }
        break;
      }
    }

    // Reference number patterns — MY bank slip formats
    var refPatterns = [
      /(?:Ref(?:erence)?|No\.?|Transaction\s*(?:ID|No\.?)?)\s*[:\.\-\s]*([A-Z0-9]{6,20})/i,
      /M2U\s*([A-Z0-9]{10,15})/i,           // Maybank2u
      /(FPX\d{7})/i,                         // FPX payment
      /(?:CIMB|RHB|PBB?|HLB)\s*([A-Z0-9]{8,16})/i,  // Bank prefix
      /\b([A-Z]{2,5}\d{8,12})\b/i           // Generic bank format
    ];
    for (var j = 0; j < refPatterns.length; j++) {
      var rm = clean.match(refPatterns[j]);
      if (rm) { reference = rm[1]; break; }
    }

    // Amount extraction — RM/MYR formats
    var amount = null;
    var amtPatterns = [
      /(?:RM\s*|MYR\s*)?(?:\$?\s*)([\d,]+\.?\d{0,2})\s*(?:RM|MYR)?/i,  // RM 1,234.56 or 1,234.56
      /(?:Total|Amount|Paid)\s*[:\.]*\s*\$?\s*([\d,]+\.?\d{0,2})/i   // "Total: 123.45"
    ];
    for (var k = 0; k < amtPatterns.length; k++) {
      var am = clean.match(amtPatterns[k]);
      if (am) {
        amount = parseFloat(am[1].replace(/,/g, ''));
        if (!isNaN(amount)) break;
        else amount = null;
      }
    }

    return { date: date, reference: reference, amount: amount, rawText: clean };
  }

  /* Main orchestrator — run OCR on file and auto-fill form fields */
  async function autoFillFromReceipt(form, file) {
    if (!file || !file.type.startsWith('image/')) return false;

    var uploadZone = form.querySelector('.tv-file-upload');
    var hintEl = uploadZone ? uploadZone.querySelector('.tv-file-upload__hint') : null;

    try {
      var worker = await initReceiptOCR();
      if (!worker) return false;

      if (hintEl) hintEl.textContent = 'Reading receipt...';

      var result = await worker.recognize(file);
      var parsed = parseBankSlip(result.data.text);

      // Auto-fill Reference No. (always overwrite)
      if (parsed.reference) {
        var refInput = form.querySelector('.pay-ref-no');
        if (refInput) {
          refInput.value = parsed.reference;
          refInput.style.borderColor = 'var(--c-success)';
          setTimeout(function () { refInput.style.borderColor = ''; }, 2000);
        }
      }

      // Auto-fill Transfer Date (always overwrite)
      if (parsed.date) {
        var dateInput = form.querySelector('.pay-date');
        if (dateInput) {
          dateInput.value = parsed.date;
          dateInput.style.borderColor = 'var(--c-success)';
          setTimeout(function () { dateInput.style.borderColor = ''; }, 2000);
        }
      }

      // Build Notes content — raw OCR + amount verification memo
      var declaredAmount = round2(form.querySelector('.pay-amount-input')?.value);
      var notesContent = parsed.rawText || '';

      // Add amount comparison memo BEFORE raw text (so it's visible at top)
      if (parsed.amount && parsed.amount > 0 && declaredAmount > 0) {
        var diff = Math.abs(parsed.amount - declaredAmount);
        var matchThreshold = 0.5; // Allow 50 sen tolerance for rounding
        var isMatch = diff <= matchThreshold;

        var memo = '--- Amount Verification ---\n';
        memo += 'Document amount: RM ' + parsed.amount.toFixed(2) + '\n';
        memo += 'Declared amount: RM ' + declaredAmount.toFixed(2) + '\n';
        if (isMatch) {
          memo += 'Status: ✓ Amounts match\n';
          hintEl.innerHTML = '<span style="color:var(--c-success);">✓ Extracted · Amount matches</span>';
        } else {
          memo += 'Status: ⚠ Amount differs by RM ' + diff.toFixed(2) + '\n';
          hintEl.innerHTML = '<span style="color:var(--c-warning-text);font-weight:600;">⚠ Amount differs</span>';
          // Flash warning on amount input
          var amtInput = form.querySelector('.pay-amount-input');
          if (amtInput) {
            amtInput.style.borderColor = 'var(--c-warning)';
            setTimeout(function () { amtInput.style.borderColor = ''; }, 4000);
          }
        }

        // Prepend memo before raw OCR text
        notesContent = memo + '\n' + notesContent;

        // Show soft info popup if amounts differ
        if (!isMatch) {
          setTimeout(function () {
            showModal({
              type: 'info',
              title: 'ℹ️ Receipt Amount Notice',
              message: 'The receipt shows <strong>RM ' + parsed.amount.toFixed(2) + '</strong> while your entered amount is <strong>RM ' + declaredAmount.toFixed(2) + '</strong>.<br><br>Difference: <strong>RM ' + diff.toFixed(2) + '</strong><br><br>This is normal for partial payments or different reference points. You may proceed — our team will verify manually.',
              button: 'I Understand'
            });
          }, 800);
        }
      } else if (parsed.amount === null && declaredAmount > 0) {
        // Could not extract amount from document
        notesContent += '\n\n--- Note: Could not auto-verify amount from this document ---';
        hintEl.innerHTML = '<span style="color:var(--c-gold-dark);">✓ Extracted (amount not detected)</span>';
      }

      // Set Notes field
      if (notesContent) {
        var notesInput = form.querySelector('.pay-notes');
        if (notesInput) {
          notesInput.value = notesContent;
        }
      }

      return true;
    } catch (e) {
      console.warn('OCR failed:', e);
      if (hintEl) hintEl.textContent = 'JPG, PNG, PDF · Max 5MB';
      return false;
    }
  }

  /* ── Fetch a document PDF from get_document_pdf.
     Backend serves the PDF as a BINARY response (frappe.response.filecontent,
     content-type application/pdf) on success, or JSON on error — _post()
     JSON-parses everything so it can't carry binary. Use raw fetch here. ── */
  async function _fetchDocPdf(doctype, docname) {
    var r = await fetch('/api/method/travel_booking.api.portal_payment.get_document_pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Frappe-CSRF-Token': _csrfToken() },
      credentials: 'include',
      body: JSON.stringify({ doctype: doctype, docname: docname })
    });

    // Binary PDF (success path) → object URL
    var ct = (r.headers.get('content-type') || '').toLowerCase();
    if (r.ok && ct.indexOf('application/pdf') !== -1) {
      var blob = await r.blob();
      return { url: URL.createObjectURL(blob) };
    }

    // JSON path — error dict or file_url fallback
    var d = await r.json().catch(function () { return {}; });
    var result = (d && d.message) || d;
    if (result && result.file_url) {
      return { url: result.file_url };
    }
    if (result && result.status === 'ok') {
      return { direct: true };
    }
    return { error: (result && result.message) || 'Document not available. Please contact support.' };
  }

  /* ── Wire up download buttons (documents + receipts) ── */
  function wireDownloadButtons() {
    // Document download buttons
    document.querySelectorAll('[data-act="download-doc"]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var docType = this.dataset.type;
        var docName = this.dataset.name;
        try {
          showToast('Preparing document...', 'info');
          var doc = await _fetchDocPdf(docType === 'invoice' ? 'Sales Invoice' : 'Proforma Invoice', docName);

          if (doc.url) {
            var a = document.createElement('a');
            a.href = doc.url;
            a.download = (docName.replace('/', '-') + '.pdf');
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            showToast('Document downloaded.', 'success');
          } else if (doc.direct) {
            showToast('Download started...', 'success');
          } else {
            showToast(doc.error, 'warning');
          }
        } catch (e) {
          var msg = e.message || '';
          if (msg.includes('500') || msg.includes('PDF')) {
            showToast('PDF generation failed. Please try again or contact support.', 'error');
          } else {
            showToast(msg || 'Failed to download document.', 'error');
          }
        }
      });
    });

    // Receipt download buttons
    document.querySelectorAll('[data-act="download-receipt"]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var payName = this.dataset.name;
        try {
          showToast('Preparing receipt...', 'info');
          var doc = await _fetchDocPdf('Payment Entry', payName);

          if (doc.url) {
            var a = document.createElement('a');
            a.href = doc.url;
            a.download = ('receipt-' + payName + '.pdf');
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            showToast('Receipt downloaded.', 'success');
          } else if (doc.direct) {
            showToast('Download started...', 'success');
          } else {
            showToast(doc.error || 'Receipt not available.', 'warning');
          }
        } catch (e) {
          showToast(e.message || 'Failed to download receipt.', 'error');
        }
      });
    });
  }

  /* ── Wire up payment forms ── */
  function wirePaymentForms() {
    // Method toggle
    document.querySelectorAll('.tv-pay-method').forEach(function (method) {
      method.addEventListener('click', function () {
        var soForm = this.closest('form');
        var m = this.dataset.method;
        soForm.querySelectorAll('.tv-pay-method').forEach(l => l.classList.remove('selected'));
        this.classList.add('selected');
        soForm.querySelectorAll('.tv-pay-radio').forEach(r => r.checked = r.value === m);
        soForm.querySelectorAll('.tv-pay-panel').forEach(p => p.classList.remove('on'));
        var target = document.getElementById('panel-' + m + '-' + soForm.dataset.so);
        if (target) target.classList.add('on');
      });
    });

    // Quick chips
    document.querySelectorAll('.tv-pay-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var form = this.closest('form');
        form.querySelectorAll('.tv-pay-chip').forEach(c => c.classList.remove('on'));
        this.classList.add('on');
        var pct = parseInt(this.dataset.pct) || 0;
        var so = allOrders.find(function(o){return o.name === form.dataset.so;});
        if (so) {
          var gt = parseFloat(so.grand_total) || 0;
          var ap = parseFloat(so.advance_paid) || 0;
          var input = form.querySelector('.pay-amount-input');
          if (input) input.value = round2((gt - ap) * pct / 100);
        }
      });
    });

    // File upload click
    document.querySelectorAll('.tv-file-upload').forEach(function (zone) {
      zone.addEventListener('click', function () {
        this.querySelector('.pay-file-input').click();
      });
    });

    // File change — trigger OCR for image files
    document.querySelectorAll('.pay-file-input').forEach(function (input) {
      input.addEventListener('change', async function () {
        var file = this.files[0];
        if (!file) return;
        var form = this.closest('form');
        if (form) autoFillFromReceipt(form, file);
      });
    });

    // Form submissions
    document.querySelectorAll('#billing-content form').forEach(function (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var action = e.submitter?.dataset?.act;
        if (action === 'pay-online') await handleOnlinePay(form);
        else if (action === 'pay-manual') await handleManualPay(form);
      });
    });
  }

  /* ── Round to 2 decimals (avoid float artifacts reaching Stripe/backend) ── */
  function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

  /* ── Strip HTML from ERPNext item descriptions (keeps line breaks) ── */
  function _stripHtml(s) {
    return String(s || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ── Handle Online Payment ── */
  async function handleOnlinePay(form) {
    var soName = form.dataset.so;
    var amountInput = form.querySelector('.pay-amount-input');
    var amount = round2(amountInput?.value);

    // Guard: elak Online Payment kalau tiada payment gateway diconfigure
    var onlineEnabled = _bankSettings && _bankSettings.online_payment_enabled !== false;
    if (!onlineEnabled) {
      showPayError(form, 'Online payment is not available. Please use Manual Bank Transfer.');
      return;
    }

    var so = allOrders.find(function (o) { return o.name === soName; });
    var outstanding = so ? round2((parseFloat(so.grand_total) || 0) - (parseFloat(so.advance_paid) || 0)) : 0;

    if (amount <= 0) {
      showPayError(form, 'Please enter a valid payment amount.');
      return;
    }

    // Stripe minimum amount (RM 2.00) — below that only manual transfer works
    var STRIPE_MIN_AMOUNT = 2.00;
    if (amount < STRIPE_MIN_AMOUNT) {
      showPayError(form, 'Minimum online payment is RM ' + STRIPE_MIN_AMOUNT.toFixed(2) + '. For amounts below RM ' + STRIPE_MIN_AMOUNT.toFixed(2) + ', please use Manual Bank Transfer.');
      return;
    }

    // Max = outstanding balance (both rounded to 2dp)
    if (outstanding > 0 && amount > outstanding) {
      showPayError(form, 'Amount exceeds the outstanding balance (' + fmtDual(outstanding) + ').');
      return;
    }

    hidePayError(form);
    var submitBtn = form.querySelector('[data-act="pay-online"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing...';

    try {
      // Build return URL — come back to this billing page after Stripe
      var returnUrl = '/traveller/billing?ref=' + encodeURIComponent(BOOKING_REF);
      var targetBill = allOrders[0] ? allOrders[0].name : '';
      if (targetBill) returnUrl += '&bill=' + encodeURIComponent(targetBill);

      var result = await API_PM('create_payment_request', {
        booking_number: BOOKING_REF,
        sales_order: soName,
        amount: amount,
        return_to: returnUrl
      });

      if (result && result.payment_url) {
        showToast('Redirecting to Stripe checkout...', 'info');
        setTimeout(function () { window.location.href = result.payment_url; }, 500);
      } else {
        showPayError(form, result.message || 'Could not initiate payment.');
      }
    } catch (e) {
      showPayError(form, e.message || 'Payment request failed.');
    }

    submitBtn.disabled = false;
    submitBtn.textContent = 'Proceed to Payment →';
  }

  /* ── Inline payment alert helpers (alert bar inside Make a Payment card) ── */
  function showPayError(form, msg) {
    var box = form ? form.parentElement.querySelector('.pay-inline-error') : null;
    if (!box) box = document.querySelector('.pay-inline-error');
    if (!box) { showInlineError('billing-error', msg); return; }
    box.textContent = msg;
    box.style.display = 'block';
  }
  function hidePayError(form) {
    var box = form ? form.parentElement.querySelector('.pay-inline-error') : null;
    if (!box) box = document.querySelector('.pay-inline-error');
    if (box) box.style.display = 'none';
  }

  /* ── Modal Popup Helper ── */
  function showModal(options) {
    var type = options.type || 'info'; // 'success', 'error', 'info'
    var title = options.title || '';
    var message = options.message || '';
    var icon = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' }[type] || 'ℹ️';
    var btnText = options.button || 'OK';
    var onConfirm = options.onConfirm || null;

    // Remove existing modal
    var existing = document.getElementById('tv-modal-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'tv-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;';

    var color = { success: 'var(--c-success)', error: 'var(--c-danger-text)', info: 'var(--c-gold-dark)', warning: 'var(--c-warning)' }[type] || '#333';

    overlay.innerHTML =
      '<div style="background:#fff;border-radius:12px;padding:28px 24px;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3);text-align:center;">' +
        '<div style="font-size:40px;margin-bottom:12px;">' + icon + '</div>' +
        (title ? '<h3 style="margin:0 0 8px;font-size:18px;color:#1E1C18;">' + _esc(title) + '</h3>' : '') +
        '<p style="margin:0 0 20px;font-size:14px;color:var(--text-secondary);line-height:1.5;">' + message + '</p>' +
        '<button id="tv-modal-btn" class="tv-btn tv-btn--primary" style="width:100%;">' + _esc(btnText) + '</button>' +
      '</div>';

    document.body.appendChild(overlay);

    // Close on button click or overlay click
    var btn = document.getElementById('tv-modal-btn');
    btn.addEventListener('click', function () {
      overlay.remove();
      if (onConfirm) onConfirm();
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        overlay.remove();
        if (onConfirm) onConfirm();
      }
    });

    return overlay;
  }

  /* ── Handle Manual Payment Upload ── */
  async function handleManualPay(form) {
    var soName = form.dataset.so;
    var amountInput = form.querySelector('.pay-amount-input');
    var dateInput = form.querySelector('.pay-date');
    var refInput = form.querySelector('.pay-ref-no');
    var notesInput = form.querySelector('.pay-notes');
    var fileInput = form.querySelector('.pay-file-input');

    var amount = round2(amountInput?.value);
    var refNo = (refInput?.value || '').trim();

    if (amount <= 0) {
      showPayError(form, 'Please enter a valid payment amount.');
      return;
    }
    // Max = outstanding balance (rounded to 2dp, same as online handler)
    var soObj = allOrders.find(function (o) { return o.name === soName; });
    var outst = soObj ? round2((parseFloat(soObj.grand_total) || 0) - (parseFloat(soObj.advance_paid) || 0)) : 0;
    if (outst > 0 && amount > outst) {
      showPayError(form, 'Amount exceeds the outstanding balance (' + fmtDual(outst) + ').');
      return;
    }
    if (!refNo) {
      showPayError(form, 'Please enter bank reference number.');
      return;
    }

    hidePayError(form);
    var submitBtn = form.querySelector('[data-act="pay-manual"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Uploading...';

    try {
      // Read file as base64
      var fileData = null;
      if (fileInput && fileInput.files[0]) {
        var file = fileInput.files[0];
        if (file.size > 5 * 1024 * 1024) {
          showPayError(form, 'File size must be under 5MB.');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit Payment Proof';
          return;
        }
        fileData = await new Promise(function (resolve) {
          var reader = new FileReader();
          reader.onload = function () { resolve(reader.result.split(',')[1]); };
          reader.readAsDataURL(file);
        });
      }

      var result = await API_PM('submit_manual_payment', {
        booking_number: BOOKING_REF,
        sales_order: soName,
        amount: amount,
        reference_no: refNo,
        payment_date: dateInput?.value || '',
        notes: notesInput?.value || '',
        filedata: fileData || '',
        filename: fileInput?.files[0]?.name || ''
      });

      // Show success modal, then refresh page to show new transaction
      showModal({
        type: 'success',
        title: 'Payment Submitted!',
        message: result.message || 'Your payment proof has been submitted successfully. We will verify within 1-2 business days.',
        button: 'Done',
        onConfirm: function () {
          window.location.reload(); // Refresh to show new transaction
        }
      });
      return; // Skip the reset below — page will reload

    } catch (e) {
      showModal({
        type: 'error',
        title: 'Submission Failed',
        message: e.message || 'Failed to submit payment. Please try again.',
        button: 'Close'
      });
    }

    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Payment Proof';
  }

  /* ── Start on DOM ready ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
