/* ============================================================
   travel_booking/public/js/portal_addons.js
   Page: /traveller_portal/booking_addons?ref=...

   Susun atur halaman:
   1. Katalog Addon Package (API_ADDON.get_available_addons) — dikumpul
      ikut addon_type (Excursion/Insurance/dsb), setiap item ada qty
      stepper. Item sold_out/cutoff_closed dipaparkan tapi butang
      dilumpuhkan (bukan hilang senyap — konsisten dgn prinsip UI app ni).
   2. Cart card melekat bawah — total + butang "Proceed to payment" yang
      TOGGLE panel bayaran INLINE (.pay-panel.on) di bawahnya sendiri —
      BUKAN modal/popup overlay. Reuse .pay-opts/.bank-details/.upload-area
      yang sama dengan booking_billing.html supaya konsisten dengan UX
      pembayaran sedia ada di seluruh portal.
   3. Checkout — panggil API_ADDON.checkout_addons, Online Payment
      redirect ke payment_url (Stripe), Manual Transfer upload resit +
      reference no terus dalam panel yang sama.

   Harga yang dipaparkan di sini SEMATA-MATA untuk UI — checkout_addons()
   re-price penuh di server, jangan sesekali percaya cart state client
   untuk apa-apa selain paparan.
   ============================================================ */

'use strict';

let BOOKING = '';
let CATALOG = [];         // hasil get_available_addons()
const CART = {};          // addon_package -> qty
let BANK_ACCOUNTS = {};   // {currency: {bank_name, account_name, account_number}}
let _addonReceiptFile = null;


/* ══════════════════════════════════════════════
   LOAD + RENDER
   ══════════════════════════════════════════════ */

async function loadAddons() {
  const container = document.getElementById('addons-container');
  if (!container) return;

  container.innerHTML = '<div style="font-size:13px;color:#B0AC9F;padding:8px 0;">Loading add-ons...</div>';
  try {
    CATALOG = await API_ADDON('get_available_addons', { booking_number: BOOKING });

    if (!CATALOG.length) {
      container.innerHTML =
        '<div class="card" style="text-align:center;padding:32px 20px;font-size:13px;color:#7D7A70;">' +
        'No add-ons or insurance are available for this trip package yet.</div>';
      return;
    }

    // Butir bank (untuk panel Manual Transfer nanti) — gagal load bukan
    // fatal, cuma pilihan Manual Transfer akan papar amaran currency.
    try {
      const s = await _post('/api/method/travel_booking.api.pricing.get_payment_settings', {});
      BANK_ACCOUNTS = (s && s.bank_accounts) || {};
    } catch (e) { /* kekal kosong */ }

    renderAddons();
    bindAddonEvents(container);
  } catch (e) {
    container.innerHTML =
      '<div class="card" style="text-align:center;padding:32px 20px;">' +
        '<div style="font-size:13px;color:#991B1B;margin-bottom:14px;">' + _esc(e.message || 'Failed to load add-ons.') + '</div>' +
        '<button class="btn btn-g" data-act="reload" style="font-size:12px;">Retry</button>' +
      '</div>';
  }
}


/* Re-render katalog + cart dari cache (currency refresh) — tanpa re-fetch.
   bindAddonEvents() TIDAK dipanggil semula: listener delegation pada
   container kekal aktif selepas innerHTML ditukar. */
function renderAddons() {
  const container = document.getElementById('addons-container');
  if (!container || !CATALOG.length) return;
  const groups = {};
  CATALOG.forEach(item => {
    const key = item.addon_type || 'Other';
    (groups[key] = groups[key] || []).push(item);
  });
  container.innerHTML =
    Object.keys(groups).map(type => renderGroup(type, groups[type])).join('') +
    renderCartBar();
  renderCart();
}

function renderGroup(type, items) {
  const label = type === 'Insurance' ? 'Travel insurance' : (type + ' & extras');
  return (
    '<div style="font-size:13px;color:#7D7A70;margin:18px 0 6px;">' + _esc(label) + '</div>' +
    '<div class="card" style="padding:4px 20px;margin-bottom:6px;">' +
      items.map(renderItemRow).join('') +
    '</div>'
  );
}

function renderItemRow(item) {
  const qty = CART[item.addon_package] || 0;
  const disabled = !item.purchasable;
  const planLabel = item.plan_type ? (' — ' + _esc(item.plan_type)) : '';
  let statusNote = '';
  if (item.sold_out) {
    statusNote = '<div style="font-size:11px;color:#991B1B;margin-top:2px;">Sold out</div>';
  } else if (item.cutoff_closed) {
    statusNote = '<div style="font-size:11px;color:#991B1B;margin-top:2px;">Sales closed for this item</div>';
  } else if (item.remaining !== null && item.remaining !== undefined && item.remaining <= 10) {
    statusNote = '<div style="font-size:11px;color:#B45309;margin-top:2px;">' + item.remaining + ' left</div>';
  }

  return (
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #F0EDE6;">' +
      '<div style="flex:1;min-width:0;padding-right:12px;">' +
        '<div style="font-weight:500;font-size:14px;color:#1E1C18;">' + _esc(item.addon_title) + planLabel + '</div>' +
        (item.description ? '<div style="font-size:12px;color:#7D7A70;margin-top:2px;">' + _esc(stripHtml(item.description)) + '</div>' : '') +
        statusNote +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">' +
        '<span style="font-size:14px;font-weight:500;color:#1E1C18;">' + fmtDual(item.unit_price) + '</span>' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<button type="button" class="btn-g" data-act="qty-dec" data-ap="' + _esc(item.addon_package) + '" ' +
            (disabled ? 'disabled' : '') + ' style="width:28px;height:28px;padding:0;font-size:14px;">−</button>' +
          '<span style="font-size:13px;min-width:16px;text-align:center;" id="qty-' + _esc(item.addon_package) + '">' + qty + '</span>' +
          '<button type="button" class="btn-g" data-act="qty-inc" data-ap="' + _esc(item.addon_package) + '" ' +
            (disabled ? 'disabled' : '') + ' style="width:28px;height:28px;padding:0;font-size:14px;">+</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function stripHtml(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}

function renderCartBar() {
  // NOTA: panel bayaran (pilihan Online/Manual) dipaparkan INLINE di bawah
  // bar ni (toggle .pay-panel.on), BUKAN sebagai modal/popup overlay —
  // reuse .pay-opts/.bank-details/.upload-area yang sama dengan
  // booking_billing.html, supaya konsisten dengan UX pembayaran sedia ada
  // di seluruh portal (tiada page lain guna popup untuk bayaran).
  return (
    '<div class="card" id="cart-card" style="position:sticky;bottom:12px;margin-top:16px;display:none;">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">' +
        '<div style="font-size:12px;color:var(--text-tertiary);">' +
          '<span id="cart-count">0</span> item selected — <span id="cart-total-line"></span>' +
        '</div>' +
        '<button type="button" class="btn btn-p" data-act="toggle-checkout" style="font-size:13px;flex-shrink:0;">Proceed to payment</button>' +
      '</div>' +
      '<div class="pay-panel" id="checkout-panel">' + renderCheckoutPanelInner() + '</div>' +
    '</div>'
  );
}

function renderCheckoutPanelInner() {
  return (
    '<div id="checkout-error" role="alert" style="display:none;font-size:11px;color:#C0392B;margin-top:2px;margin-bottom:10px;"></div>' +
    '<div class="pay-opts">' +
      '<label class="pay-opt on" data-act="method" data-kind="online">' +
        '<input type="radio" name="addon-pm" value="Online Payment" checked/>' +
        '<span style="flex:1;min-width:0;">' +
          '<span class="pay-opt__label">Online Payment</span>' +
          '<span class="pay-opt__desc">Pay securely by debit or credit card</span>' +
        '</span>' +
      '</label>' +
      '<label class="pay-opt" data-act="method" data-kind="manual">' +
        '<input type="radio" name="addon-pm" value="Manual Transfer"/>' +
        '<span style="flex:1;min-width:0;">' +
          '<span class="pay-opt__label">Manual Bank Transfer</span>' +
          '<span class="pay-opt__desc">Pay via bank transfer, verified within 1–2 business days</span>' +
        '</span>' +
      '</label>' +
    '</div>' +
    '<div class="pay-panel" id="panel-manual-addon">' +
      '<div id="bank-details-slot"></div>' +
      '<div class="f"><label class="lbl" for="bank-ref">Bank transfer reference no. <span style="color:#C0392B;">*</span></label>' +
        '<input type="text" id="bank-ref" placeholder="e.g. FPX20260410-12345"/></div>' +
      '<button type="button" class="upload-area" id="addon-upload-area" data-act="upload" style="width:100%;text-align:left;font:inherit;cursor:pointer;">' +
        '<div class="upload-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>' +
        '<div class="upload-txt" id="addon-upload-txt">Upload payment proof <span style="color:#C0392B;">*</span></div>' +
        '<div class="upload-sub">JPG, PNG or PDF · Max 5MB</div>' +
      '</button>' +
    '</div>' +
    '<button type="button" class="btn btn-p" id="confirm-checkout-btn" data-act="confirm-checkout" style="width:100%;margin-top:14px;">Confirm</button>'
  );
}


/* ══════════════════════════════════════════════
   CART STATE
   ══════════════════════════════════════════════ */

function changeQty(apName, delta) {
  const item = CATALOG.find(i => i.addon_package === apName);
  if (!item || !item.purchasable) return;

  const current = CART[apName] || 0;
  let next = Math.max(0, current + delta);
  if (item.max_qty_per_booking) next = Math.min(next, item.max_qty_per_booking);
  if (item.remaining !== null && item.remaining !== undefined) next = Math.min(next, item.remaining);

  if (next === 0) delete CART[apName]; else CART[apName] = next;

  const qtyEl = document.getElementById('qty-' + apName);
  if (qtyEl) qtyEl.textContent = next;
  renderCart();
}

function renderCart() {
  const apNames = Object.keys(CART);
  const bar = document.getElementById('cart-card');
  if (!bar) return;

  if (!apNames.length) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';

  let count = 0;
  let cartTotal = 0;
  apNames.forEach(ap => {
    const item = CATALOG.find(i => i.addon_package === ap);
    if (!item) return;
    count += CART[ap];
    cartTotal += item.unit_price * CART[ap];
  });

  document.getElementById('cart-count').textContent = count;
  document.getElementById('cart-total-line').innerHTML = fmtDual(cartTotal);
}


/* ══════════════════════════════════════════════
   CHECKOUT PANEL (inline, bukan modal)
   ══════════════════════════════════════════════ */

function toggleCheckoutPanel() {
  const panel = document.getElementById('checkout-panel');
  if (!panel) return;
  const opening = !panel.classList.contains('on');
  panel.classList.toggle('on', opening);
  if (opening) fillBankDetails();
}

function selectPaymentMethod(kind) {
  document.querySelectorAll('.pay-opts .pay-opt').forEach(el => {
    el.classList.toggle('on', el.dataset.kind === kind);
    const r = el.querySelector('input[type="radio"]');
    if (r) r.checked = el.dataset.kind === kind;
  });
  const manualPanel = document.getElementById('panel-manual-addon');
  if (manualPanel) manualPanel.classList.toggle('on', kind === 'manual');
}

function fillBankDetails() {
  const apNames = Object.keys(CART);
  const items = CATALOG.filter(i => apNames.includes(i.addon_package));
  const currency = items.length ? items[0].currency : 'MYR';
  const bank = BANK_ACCOUNTS[currency] || {};
  const slot = document.getElementById('bank-details-slot');
  if (!slot) return;

  if (!bank.account_number) {
    slot.innerHTML = '<div style="font-size:12px;color:#C0392B;margin-bottom:10px;">' +
      'Manual transfer is not configured for ' + _esc(currency) + '. Please use Online Payment instead.</div>';
    return;
  }
  slot.innerHTML =
    '<div class="bank-details">' +
      '<div class="bank-row"><span>Bank</span><strong>' + _esc(bank.bank_name || '') + '</strong></div>' +
      '<div class="bank-row"><span>Account Name</span><strong>' + _esc(bank.account_name || '') + '</strong></div>' +
      '<div class="bank-row"><span>Account No.</span><strong>' + _esc(bank.account_number || '') + '</strong></div>' +
    '</div>';
}

function triggerAddonUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf';
  input.onchange = e => {
    const file = e.target.files[0];
    const errEl = document.getElementById('checkout-error');
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      errEl.textContent = 'File must be under 5MB — "' + file.name + '" is ' + (file.size / 1024 / 1024).toFixed(1) + 'MB.';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';
    _addonReceiptFile = file;
    document.getElementById('addon-upload-txt').textContent = '✓ ' + file.name;
    document.getElementById('addon-upload-area').style.borderColor = '#0F6E56';
  };
  input.click();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function confirmCheckout() {
  const errBox = document.getElementById('checkout-error');
  errBox.style.display = 'none';

  const checkedRadio = document.querySelector('input[name="addon-pm"]:checked');
  const pm = checkedRadio ? checkedRadio.value : 'Online Payment';
  const lines = Object.keys(CART).map(ap => ({ addon_package: ap, qty: CART[ap] }));

  let receiptDataUrl = null;
  let bankRef = '';
  if (pm === 'Manual Transfer') {
    bankRef = (document.getElementById('bank-ref').value || '').trim();
    if (!bankRef) {
      errBox.textContent = 'Please enter your bank transfer reference number.';
      errBox.style.display = 'block';
      return;
    }
    if (!_addonReceiptFile) {
      errBox.textContent = 'Please upload your payment proof (receipt from your bank/transfer).';
      errBox.style.display = 'block';
      return;
    }
    receiptDataUrl = await fileToDataUrl(_addonReceiptFile);
  }

  const btn = document.getElementById('confirm-checkout-btn');
  btn.disabled = true;
  btn.textContent = 'Processing...';

  try {
    const result = await API_ADDON('checkout_addons', {
      booking_number: BOOKING,
      lines: JSON.stringify(lines),
      payment_method: pm,
      receipt: receiptDataUrl,
      bank_transfer_ref: bankRef,
    });

    if (pm === 'Online Payment' && result.payment_url) {
      window.location.href = result.payment_url;
      return;
    }

    Object.keys(CART).forEach(k => delete CART[k]);
    _addonReceiptFile = null;
    const container = document.getElementById('addons-container');
    container.insertAdjacentHTML('afterbegin',
      '<div class="card" style="padding:16px 20px;margin-bottom:14px;border-left:3px solid #1D9E75;">' +
        '<div style="font-size:13px;color:#1E1C18;">Order placed — we\'ll confirm once your payment is verified.</div>' +
      '</div>'
    );
    await loadAddons();
  } catch (e) {
    errBox.textContent = e.message || 'Checkout failed. Please try again.';
    errBox.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Confirm';
  }
}


/* ══════════════════════════════════════════════
   EVENT DELEGATION
   ══════════════════════════════════════════════ */

function bindAddonEvents(container) {
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const ap = btn.dataset.ap;

    if (act === 'qty-inc') changeQty(ap, 1);
    else if (act === 'qty-dec') changeQty(ap, -1);
    else if (act === 'reload') window.location.reload();
    else if (act === 'toggle-checkout') toggleCheckoutPanel();
    else if (act === 'method') selectPaymentMethod(btn.dataset.kind);
    else if (act === 'upload') triggerAddonUpload();
    else if (act === 'confirm-checkout') confirmCheckout();
  });
}


/* ══════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
  const ok = await ensureSession();
  if (!ok) return;
  renderNav();
  window.rcRefreshCurrency = renderAddons;

  BOOKING = _pageData.booking_ref || '';
  if (!BOOKING) return;
  await loadAddons();
});