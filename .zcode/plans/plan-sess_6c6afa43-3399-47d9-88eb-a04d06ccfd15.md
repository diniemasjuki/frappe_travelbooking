## Punca Error

`stripe_checkout.py` guna `_(...)` (fungsi terjemahan Frappe) di 3 tempat dalam `create_payment_intent()` — baris 200, 241, 257 — tetapi **tiada `from frappe import _`** di atas fail. Bila salah satu cabang `frappe.throw(_(...))` sampai, Python `NameError: name '_' is not defined`.

Error ni ditangkap oleh `except Exception` luas dalam `_create_payment_url()` (`so_helpers.py:512`), dilog, dan pulangkan `""`. Customer nampak halaman confirmation (booking "berjaya") tapi tak dibawa ke Stripe — bayaran hilang senyap.

## Bug pendam yang sama (4 fail total tiada import `_`)

| Fail | Baris | Laluan |
|------|-------|--------|
| `stripe_checkout.py` | 200, 241, 257 | Online Payment checkout ← **error sekarang** |
| `so_helpers.py` | 489 | Manual Transfer payment receipt |
| `price_labels.py` | 12 | Deprecated endpoint |
| `voucher.py` | 289, 297 | Voucher usage limits |

## Pelan Pembaikan

**Langkah 1 — Tambah `from frappe import _` ke 4 fail:**

1. `travel_booking/api/stripe_checkout.py` — tambah selepas `import frappe` (baris 11)
2. `travel_booking/api/so_helpers.py` — tambah selepas `import frappe` (baris 10)
3. `travel_booking/api/price_labels.py` — tambah selepas `import frappe`
4. `travel_booking/api/voucher.py` — tambah selepas `import frappe`

Ini 100% fix error sekarang. Bila import dah ada, cabang `frappe.throw(_(...))` akan raise `ValidationError` dengan mesej sebenar (bukan `NameError`), atau kalau validation lulus, Stripe checkout URL akan dicipta dengan betul.

**Langkah 2 — Verify via HTTP curl** (bukan console, ikut memory `bench-log-permission-trap`):
- Buat test checkout dengan Online Payment dan sahkan `payment_url` dikembalikan bukan kosong
- Jika masih kosong, baca Error Log (`tabError Log` title "Payment URL Error") — mesej validation sebenar akan tunjuk sama ada ada isu konfigurasi Travel Settings (cth `online_payment_min_amount` terlalu tinggi, atau `default_deposit_percent` mismatch)

## Nota: Kenapa cabang validation mungkin trigger walaupun flow normal

Berdasaskan analisa kod, untuk flow checkout biasa (Deposit = std_deposit, Full = grand_total), cabang validation di `create_payment_intent` **patutnya tak trigger** kerana `booking_engine.py` sudah kira deposit dengan betul dan angkat ke `online_min` kalau perlu. Punca kemungkinan:

1. **`frappe.set_user` session corruption** (rujuk memory `frappe-set-user-corrupts-sessions`) — selepas `frappe.set_user("Administrator")` lalu `frappe.set_user("Guest")` di booking_engine.py:287/385, `frappe.session.user` mungkin tak kembali ke "Guest". Kalau jadi "Administrator", `get_customer_by_email("Administrator")` mungkin pulangkan customer lain → ownership check (baris 198) trigger → `_()` NameError. Ini persoalan berasingan — fix import `_` dulu, kalau error masih berulang selepas import ditambah, siasat `set_user` ini.
2. **Mismatch Travel Settings** — `online_payment_min_amount` atau `default_deposit_percent` tidak selaras dengan kiraan deposit.

Fix import `_` adalah langkah pertama yang wajib. Selepas itu, kalau masalah berterusan, Error Log akan tunjuk mesej validation sebenar yang membolehkan diagnosis lanjut.