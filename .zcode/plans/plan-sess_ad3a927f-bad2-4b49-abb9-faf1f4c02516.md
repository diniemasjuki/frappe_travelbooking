## Konteks

Voucher/referral discount kini tidak ditolak pada Sales Order (SO kekal GROSS) — diserap sebagai baris **deduction ke akaun Marketing Expenses pada Payment Entry**, termasuk mesinari penyelesaian khas untuk laluan Stripe (`_settle_order_discount_residue`). Prinsip baharu (arah user): **diskaun ialah catatan jualan** — direfleksikan pada SO sebagai Additional Discount standard ERPNext (SO jadi NET, corak sedia ada untuk B2B di `booking_engine.py:725-728`), di-snapshot pada `Booking.voucher_discount/referral_discount` sebagai catatan, dan **Payment Entry hanya rakam cash**. Cashback Manual Transfer **KEKAL** sebagai PE deduction (ia benefit transaksional ikut kaedah bayaran — memang tempatnya di PE).

Kesan matematik: contoh SO RM1,000 + voucher RM100 → SO `discount_amount = 100`, `grand_total = 900`; deposit PE allocate RM180 cash terus — tiada deduction, tiada settlement entry, SO settle tepat.

## Kompatibiliti data lama (tiada migrasi)

SO lama masih GROSS dengan baki diskaun belum diserap. Fungsi guard baharu di `so_helpers.py`:

```python
def _so_carries_order_discount(so_name) -> bool:
    """True = diskaun voucher/referral DAH dibawa pada SO (model baharu /
    tiada diskaun); False = SO GROSS, diskaun diserap via PE (model lama)."""
    # Tiada Booking linked → True (tiada diskaun order-level)
    # Booking.voucher_discount/referral_discount <= 0 → True
    # lain: True bila SO.discount_amount > 0, False jika == 0
```

Semua laluan bayaran branch pada guard ini — model lama kekal berfungsi untuk rekod sedia ada, model baharu untuk booking selepas deploy. **Perangkap yang dielakkan**: formula residue lama `min(diskaun − diserap, grand_total − advance_paid)` AKAN bersilap untuk SO net baharu bila deposit dibayar dulu (cth deposit 180 atas SO net 900 → residue 720 → PE hantu) — jadi settlement mesti di-guard, bukan dibiarkan.

## Perubahan mengikut fail

**1. `travel_booking/api/booking_engine.py` (`confirm_booking`)**
- Selepas kiraan `voucher_discount`/`referral_discount` (kini ~line 543-570): tambah branch berasingan (BUKAN dalam elif cashback/B2B — voucher boleh co-exist dengan cashback; B2B memang throw atas voucher jadi tiada konflik slot):
  ```python
  if voucher_discount > 0 or referral_discount > 0:
      so_payload.update({
          "apply_discount_on": "Grand Total",
          "discount_amount": round(voucher_discount + referral_discount, 2),
      })
  ```
- Line 768: `net_total = round(float(so.grand_total or 0), 2)` — SO dah net. Kemaskini komen blok 535-542 ("MODEL BARU (PE deduction)" → model additional discount).
- Buang `gross_allocated_pe` (line 826-829); panggilan `_create_manual_payment_entry` (line 1005-1020): `allocated_amount = deposit_amount` (dah setara cash + cashback), **buang `discount_components`**.
- Snapshot `Booking.voucher_discount/referral_discount` (line 871-872) **KEKAL** (catatan jualan) — komen dikemaskini.

**2. `travel_booking/api/so_helpers.py`**
- Tambah `_so_carries_order_discount()`.
- `_create_manual_payment_entry` (line 956+): buang param `discount_components`, panggilan `_build_discount_deduction_rows`, append baris disc (1063-1065), remarks "Order discount..." (1072-1075). **Kekalkan** laluan cashback penuh (`_resolve_cashback_deduction`, allocated = cash + cashback).
- Kekalkan `_build_discount_deduction_rows`, `_get_absorbed_order_discount`, `_settle_order_discount_residue`, `_get_order_discount_total`, `_get_booking_discount_snapshot` — legacy sahaja, di-guard. Kemaskini komen section 718-733.

**3. `travel_booking/api/portal_payment.py` (`submit_manual_payment`, line 610-664)**
- Perubahan minimum: selepas `_get_booking_discount_snapshot` (line 625):
  ```python
  order_discount = 0 if _so_carries_order_discount(target_so) \
      else round(_b_voucher_disc + _b_ref_disc, 2)
  ```
  Dengan `order_discount = 0`: residue = 0 → `_build_discount_deduction_rows` pulangkan `([], 0)` → tiada baris, tiada fallback reset, dan formula `net_full`/`allocated` sedia ada berjalan atas cashback sahaja. Laluan lama (guard False) tak tersentuh. Kemaskini komen 610-622 & remarks.

**4. `travel_booking/api/stripe_checkout.py`**
- `create_payment_intent` (line 250-255): `net_payable = effective_so_total` bila `_so_carries_order_discount()` True; formula lama (gross − snapshot) untuk rekod lama.
- `_mark_payment_request_paid` blok settlement (line 821-836): bungkus panggilan `_settle_order_discount_residue` dengan guard — skip untuk SO model baharu (lihat perangkap di atas).

**5. `travel_booking/module_travel_booking/doctype/booking/booking.json`**
- Kemaskini field description `voucher_discount` & `referral_discount` (masa ni menyata "SO kekal GROSS; diserap sebagai Payment Entry deduction") → "Diskaun dibawa pada SO (additional discount); field ini snapshot/catatan sahaja."

**6. `travel_booking/public/js/booknow.js`** — kosmetik sahaja
- Tiada perubahan math (disahkan: `calcDiscountedTotal()` line 4637-4669 dah sepadan dengan SO net). Kemaskini komen lapuk (line 4656-4661, 3852) yang menyata model PE deduction.

## Yang TIDAK berubah

- **Cashback Manual Transfer**: PE deduction ke Marketing Expenses, semua formula (`cash_due`, `net_full`, reverse-derivation portal) kekal; `other_deductions` kini sentiasa 0.
- Snapshot Booking (`pre_discount_total`, `voucher_discount`, `referral_discount`, `payment_due_amount`) — `_recompute_booking_status` (line 1177-1190) dah add-back SO `discount_amount`, jadi konsisten automatik; `advance_paid` kini cash-tulen (lebih betul untuk status payment).
- Commission affiliate — base `base_net_amount` baris SO tak terjejas additional discount (disahkan di `apps/affiliate/affiliate/api/commission_sync.py`).
- Semua pembaca catatan (manage_trip_booking aggregates/CSV, admin JS, portal JS, Booking Reservation snapshot) — baca field Booking yang kekal.
- Deposit math, `online_payment_min_amount` guard, Pay Later, wizard frontend.

## Tests & Verifikasi

1. **Test baharu** `travel_booking/api/test_order_discount.py` (UnitTestCase, mock `frappe.db`): guard `_so_carries_order_discount` (4 kes: legacy gross → False; SO net → True; tiada Booking → True; tiada diskaun → True); `_resolve_cashback_deduction` dengan `other_deductions=0`; `_build_discount_deduction_rows` filter `amt<=0`. Comment/docstring dalam BM, hermetic.
2. `bench --site _rare migrate` (booking.json) → `bench --site _rare run-tests --module travel_booking.api.test_order_discount` → full suite `bench --site _rare run-tests --app travel_booking`.
3. **E2E di `_rare` (dev site)** via `bench --site _rare console`:
   - Sahkan guard pulangkan False untuk booking lama bervoucher yang sedia ada (read-only).
   - Cipta scratch Voucher (Fixed, Active) + booking scratch melalui `confirm_booking` (guna email customer sedia ada yang ada User — langkau OTP gate); sahkan: SO `discount_amount` == voucher, `grand_total` == net; PE Manual Transfer allocate cash sahaja tanpa baris "Order Discount"; (Online) `create_payment_intent` caj net & tiada settlement PE selepas `_mark_payment_request_paid` disimulasikan. Kemudian cancel/bersihkan rekod scratch.
4. Regresi legacy: booking lama GROSS bervoucher di `_rare` — bayaran baki portal masih bina baris deduction "Order Discount" (laluan guard False).

Tiada patch migrasi diperlukan; tiada bump `?v=` (portal assets guna `asset_v()` mtime-based).