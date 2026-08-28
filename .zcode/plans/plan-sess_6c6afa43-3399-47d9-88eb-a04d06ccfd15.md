## Guard Tiga Lapisan: Halang "False Success" Bila Payment URL Gagal

### Fail 1: `travel_booking/api/so_helpers.py` — `_create_payment_url` (baris 498-515)

Tukar return type dari `str` ke `tuple (url, error)`:

- **Berjaya:** pulangkan `(checkout_url, None)`
- **ValidationError** (cth "Minimum payment 20%"): log + pulangkan `("", str(e))` — mesej sebenar supaya customer tahu kenapa
- **Exception lain** (Stripe API, network): log + pulangkan `("", "Payment setup failed. Please complete your payment from the portal or contact support.")`

Booking TETAP dicommit (tidak di-rollback) — emel "set password" sudah dihantar, dan customer patut ada rekod booking untuk bayar lewat di portal.

### Fail 2: `travel_booking/api/booking_engine.py` — `confirm_booking`

**Baris 512-520** — kemas kini caller untuk tangkap tuple:
```python
payment_url = ""
payment_error = None
if payment_method == "Online Payment":
    pay_amount = deposit_amount if payment_type == "Deposit" else grand_total
    payment_url, payment_error = _create_payment_url(
        customer_name=customer_name, so_name=so.name,
        amount=pay_amount, booking_number=booking.booking_number,
    )
```

**Baris 554-569** — tambah dua field baru dalam return dict:
```python
"payment_setup_failed": bool(payment_error),
"payment_error":  payment_error,
```
`payment_error` ialah `None` untuk non-Online-Payment (jadi `payment_setup_failed` = False secara default).

### Fail 3: `travel_booking/www/booknow.html` — Step 4 confirmation card (baris 510)

Tambah elemen kosong untuk amaran, selepas `bnwConfirmStatusBadge`:
```html
<div id="bnwConfirmStatusBadge" style="margin:8px 0 4px"></div>
<div id="bnwPaymentWarning"></div>
<div class="bnw-confirm-details" id="bnwConfirmDetails"></div>
```

### Fail 4: `travel_booking/public/js/booknow.js` — response handler (baris 3676-3713)

**Tambah guard selepas `if (result.payment_url)` block:**
```javascript
// Payment setup failed — booking dicipta tapi URL bayaran gagal.
if (result.payment_setup_failed) {
  showConfirmation(result);
  showStep(4);
  renderPaymentWarning(result.payment_error);
  return;
}
```

**Tambah fungsi baru `renderPaymentWarning(errorMsg)`:**
- Tukar icon confirmation dari check hijau ke alert oren (`ti-alert-circle`, background `#d97706→#f59e0b`)
- Isi `#bnwPaymentWarning` dengan banner amaran kuning (background `#FEF3C7`, border `#F59E0B`) yang papar mesej ralat sebenar
- Override `#bnwConfirmEmail` dengan mesej: "Your booking has been created, but online payment could not be set up. Please log in to your portal to complete payment."

**Tambah reset di awal `showConfirmation()`** — kosongkan `#bnwPaymentWarning` dan reset icon ke default (check hijau), supaya amaran tak lekat kalau customer retry tanpa reload page.

### Aliran selepas fix

```
confirm_booking()
  ├─ Cipta Booking + SO + hantar emel set-password
  ├─ _create_payment_url() → (url, error)
  │    ├─ Berjaya: ("https://checkout.stripe.com/...", None)
  │    └─ Gagal: ("", "Minimum payment is 20%...")
  ├─ frappe.db.commit()
  └─ return { success: True, payment_url, payment_setup_failed, payment_error }

booknow.js
  ├─ if (result.payment_url) → redirect Stripe ✓
  ├─ if (result.payment_setup_failed) → showConfirmation + renderPaymentWarning
  │    Customer nampak: amaran oren "Online Payment Setup Failed" + mesej sebenar
  │    + arahan "log in ke portal untuk bayar"
  └─ else → showConfirmation (Manual Transfer / Pay Later) ✓
```

### Fail yang diubah (4)
1. `so_helpers.py` — return tuple + split ValidationError/Exception
2. `booking_engine.py` — tangkap tuple + tambah 2 field response
3. `www/booknow.html` — tambah `<div id="bnwPaymentWarning">`
4. `public/js/booknow.js` — guard + `renderPaymentWarning()` + reset di `showConfirmation()`

Semua boih balik (reversible). Selepas implement, reload gunicorn (HUP) dan verify via curl.