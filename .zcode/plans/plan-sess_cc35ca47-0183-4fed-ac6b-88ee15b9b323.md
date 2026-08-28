## Plan: Minimum Amount untuk Online Payment (Travel Settings)

**Tujuan:** Tambah medan konfigurasi "Online Payment Minimum Amount" (dalam company currency) di Travel Settings. Bila jumlah caj customer di bawah minimum, sembunyikan pilihan Online Payment (mirror kelakuan sedia ada bila tiada gateway) + fallback ke Manual/Held, dan tambah guard server-side supaya Stripe checkout tak pernah dimulakan di bawah minimum.

### 1. Doctype — Travel Settings (tambah medan)
**Fail:** `travel_booking_management/doctype/travel_settings/travel_settings.json`
- Tambah field `online_payment_min_amount` (Float), label "Online Payment Minimum Amount", dalam section `deposit_and_payment_section`, selepas `default_deposit_percent`.
- Description: "Minimum chargeable amount (company currency) for Online Payment. Below this, Online Payment is hidden. Leave 0 to disable."
- Laksana: edit JSON + `bench --site site.dev migrate` (tambah DB column + DocField). Selepas migrate, `chown` log ke frappe (elak trap log-ownership 500).

### 2. Backend — dedah setting ke frontend
**Fail:** `api/pricing.py` (`get_payment_settings`, line 26)
- Tambah ke return dict: `"online_payment_min_amount": float(getattr(settings, "online_payment_min_amount", 0) or 0)`.

### 3. Backend — guard server-side (defense in depth)
**Fail:** `api/stripe_checkout.py` (`create_payment_intent`, line 166)
- Selepas semakan min-deposit sedia ada (~line 237), tambah:
  ```python
  online_min = float(getattr(settings, "online_payment_min_amount", 0) or 0)
  if online_min and amount < online_min:
      frappe.throw(_("Online payment requires a minimum of {0}.").format(
          frappe.utils.fmt_money(online_min, 2, company_currency)),
          title=_("Below Minimum"))
  ```
- `settings` & currency dah in-scope (line 229 guna `getattr(settings, ...)`). Ini cover SEMUA online charge termasuk portal billing (sebab create_paymentIntent dikongsi).

### 4. Frontend — booknow.js
- Defaults `state_payment_settings` (line ~99 + fallback ~2766): tambah `online_payment_min_amount: 0`.
- `loadPaymentSettings()` (line 2666): simpan `online_payment_min_amount: float(result.online_payment_min_amount || 0)`.
- Fungsi baharu `evaluateOnlinePayment()` — single source of truth untuk visibility radio Online:
  - `chargeable = state_payment_amount || getMinPay()` (deposit kalau belum set).
  - `available = s.online_payment_enabled && chargeable >= s.online_payment_min_amount`.
  - Show/hide `bnwLabelOnline`. Kalau hide & Online terpilih, fallback ke Manual (kalau bank ada) atau Held Booking — mirror fallback sedia ada (lines 2828-2835).
  - Show/hide note `bnwOnlineMinNote`: "Online payment requires a minimum of {fmt(min)}".
- Gantikan blok inline online (lines 2816-2837) dgn panggilan `evaluateOnlinePayment()`.
- Panggil `evaluateOnlinePayment()` di hujung `refreshPaySummary()` (line 3121) — re-eval bila customer tukar Deposit↔Full / edit amount.

### 5. Frontend — booknow.html
- Tambah note element di bawah radio Online (~line 334): `<small class="bnw-radio-note" id="bnwOnlineMinNote" style="display:none"></small>`.

### Verification
- Set `online_payment_min_amount = 50` di Travel Settings (Desk).
- Buka booknow untuk trip deposit < 50 tapi full >= 50. Confirm: Deposit dipilih → Online hidden + note tunjuk; tukar "Pay Full" → Online muncul semula.
- curl `get_payment_settings` → `online_payment_min_amount` ada.
- curl `create_payment_intent` amount < min → frappe.throw (417).

### Skop
- Wizard booknow (new booking) dapat frontend gating penuh.
- Portal billing pages (traveller_billing, portal_payment) dilindungi guard server-side (create_payment_intent dikongsi) — frontend portal di-skip (out of scope, guard server cukup).