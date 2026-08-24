# travel_booking/api/booking.py
#
# Lapisan re-export untuk kebolehlarian ke belakang (backward compatibility).
#
# booking.py asal (2266 baris, 42 fungsi) telah dipecahkan kepada modul-modul
# fokus yang berikut (rujuk setiap fail untuk dokumentasi terperinci):
#
#   constants.py       — pemalar dikongsi (MAX_CABINS_PER_BOOKING, PRINT_FORMAT_RECEIPT, dll.)
#   otp.py             — penghantaran & pengesahan OTP (guest booking)
#   voucher.py         — pengesahan voucher & affiliate + lifecycle voucher
#   pricing.py         — kiraan harga backend + butiran trip/kabin wizard
#   so_helpers.py      — helper Sales Order, Customer, Payment Entry, auto-invoice
#   email_service.py   — emel status booking, resit, set-password
#   booking_engine.py  — confirm_booking + status engine + cascade cancel + hooks
#
# Semua import sedia ada dari `travel_booking.api.booking` terus berfungsi
# kerana lapisan ni mengeksport semula setiap simbol. hooks.py (doc_events,
# scheduler_events) juga masih boleh rujuk travel_booking.api.booking.* jika
# mahu, walaupun telah dikemaskini untuk terus menunjuk ke modul baharu.
#
# PENTING: JANGAN tambah logik baharu di sini. Tambah di modul yang betul,
# kemudian tambah baris re-export di bawah kalau perlu.

from travel_booking.api.constants import (
    MAX_CABINS_PER_BOOKING,
    PRINT_FORMAT_RECEIPT,
    TRAVEL_ITEM_CODE,
    BOOKING_NUMBER_PREFIX,
    DEFAULT_CURRENCY,
    get_max_cabins,
)

from travel_booking.api.otp import (
    send_otp,
    verify_otp,
)

from travel_booking.api.voucher import (
    validate_voucher,
    validate_affiliate_code,
    _use_voucher,
    _release_voucher_for_booking,
)

from travel_booking.api.pricing import (
    get_payment_settings,
    get_sales_persons,
    get_wizard_confirmation,
    get_booking_details,
    fmt_currency,
    _get_pricing_map,
    _price_selection,
    _validate_selection_capacity,
)

from travel_booking.api.so_helpers import (
    _resolve_booking_from_so,
    _get_all_booking_sales_orders,
    _get_primary_so,
    _compute_payment_status,
    _create_customer,
    _build_so_items,
    _so_line,
    _get_or_create_travel_item,
    _cabin_layout_from_so,
    _activate_booking,
    _create_manual_payment_entry,
    _create_payment_url,
    _maybe_auto_invoice_so,
)

from travel_booking.api.email_service import (
    get_site_url,
    _generate_set_password_url,
    _send_set_password_email,
    _booking_email_context,
    _send_status_email,
    _receipt_pdf,
    _send_receipt_email,
)

from travel_booking.api.booking_engine import (
    confirm_booking,
    _recompute_booking_status,
    _cancel_booking_cascade,
    mark_completed_trips,
    on_payment_entry_submit,
    on_payment_entry_cancel,
    on_booking_update,
    _generate_booking_number,
    _ensure_portal_user,
)
