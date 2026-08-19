# travel_booking/api/booking_engine.py
#
# "Orchestrator" utama: confirm_booking (the big one), status engine
# (_recompute_booking_status), cascade cancel, scheduled tasks, doc event
# hooks (Payment Entry submit/cancel, Booking update), dan helper-helper
# berkaitan nombor booking & pengguna portal.
#
# Modul ni import dari hampir semua modul lain (pricing, so_helpers,
# email_service, voucher, constants, _helpers) — tapi TIADA modul lain
# yang import balik dari booking_engine (kecuali booking.py re-export layer),
# jadi tiada risiko circular import.

import frappe
import json
import random
import string

from travel_booking.api._helpers import get_customer_by_email, get_company_currency
from travel_booking.api.pricing import (
    _get_pricing_map,
    _validate_selection_capacity,
)
from travel_booking.api.so_helpers import (
    _create_customer,
    _ensure_customer_company_currency,
    _build_so_items,
    _get_or_create_travel_item,
    _create_manual_payment_entry,
    _create_payment_url,
    _resolve_booking_from_so,
    _get_all_booking_sales_orders,
    _get_primary_so,
    _compute_payment_status,
    _activate_booking,
    _maybe_auto_invoice_so,
)
from travel_booking.api.email_service import (
    _send_status_email,
    _send_set_password_email,
    _send_receipt_email,
)
from travel_booking.api.voucher import (
    validate_voucher,
    validate_affiliate_code,
    _use_voucher,
    _release_voucher_for_booking,
)


# ══════════════════════════════════════════════
# 7. CONFIRM BOOKING
# ══════════════════════════════════════════════

@frappe.whitelist(allow_guest=True)
def confirm_booking(trip_group_date: str, selections: str, billing: str,
                    payment_type: str = "Full Payment", payment_method: str = "Online Payment",
                    receipt: str = None, voucher_code: str = "", affiliate_code: str = "", amount_paid: float = None,
                    trip_package: str = None, sales_persons: str = None, bank_transfer_ref: str = None):
    if isinstance(selections, str):
        selections = json.loads(selections)
    if isinstance(billing, str):
        billing = json.loads(billing)

    email = billing.get("email", "").strip().lower()
    bank_transfer_ref = (bank_transfer_ref or "").strip()

    if payment_method == "Manual Transfer" and not bank_transfer_ref:
        # Nombor rujukan transaksi DARI BANK CUSTOMER SENDIRI (bukan rujukan
        # booking kami) — perlu untuk admin padankan bayaran ni dengan
        # penyata bank semasa verify manual. Wajib diisi di frontend
        # (booking.html/js), tapi disahkan semula di sini supaya panggilan
        # terus ke API (skip frontend) tak boleh langkau keperluan ni.
        frappe.throw("Please enter your bank transfer reference number.")

    # PENTING: gate OTP ni MESTI konsisten dengan send_otp()'s logic
    # (check User/akaun portal, bukan Customer) — kalau tidak, boleh
    # berlaku kes frontend skip OTP (sebab send_otp() kata verified=True
    # ikut User wujud) tapi backend di sini masih throw sebab Customer
    # tak wujud (cth booking pertama customer tu, User belum dicipta lagi
    # tapi dia baru sahaja verify OTP dalam sesi ni — is_verified cache
    # akan cover kes tu). existing_customer (rekod Customer, kalau ada)
    # kekal diguna BERASINGAN semata-mata untuk elak cipta Customer
    # berganda — bukan untuk tentukan sama ada OTP diperlukan.
    #
    # DESYNC DIENDALI: dua sumber "sahkan email" yang boleh putus:
    #   (a) is_verified cache (TTL 30 min dari email_verified_session_minutes)
    #   (b) has_portal_user (User wujud — bermaksud customer PERNAH verify
    #       email pada booking terdahulu, rekod kekal dalam DB)
    # Customer yang ada akaun portal (b) TIDAK perlu OTP lagi — dia dah
    # disahkan sekali sewaktu pendaftaran. Hanya customer BARU (tiada
    # User) yang perlu OTP segar (a) dalam tetingkap 30 minit. Jika cache
    # (a) dah tamat untuk customer baru, mesej jelas suruh re-verify
    # (bukan "email belum disahkan" yang mengelirukan — seolah-olah
    # customer tak pernah verify langsung, padahal verify, cuma tamat).
    is_verified       = frappe.cache().get_value("booking_email_verified_" + email)
    has_portal_user   = bool(frappe.db.exists("User", email))
    existing_customer = get_customer_by_email(email)

    if not has_portal_user and not is_verified:
        frappe.throw(
            "Your email verification session has expired (30 minutes). "
            "Please request a new OTP code and verify again to continue your booking."
        )

    customer_name = existing_customer or _create_customer(billing)

    # Penjajar currency customer — SEMUA transaksi kini dalam company
    # currency. Pastikan Customer.default_currency = company currency
    # sebelum SO dicipta (SO set currency/conversion_rate eksplisit jua,
    # ini cuma penjajar data customer untuk konsistensi).
    _ensure_customer_company_currency(customer_name)

    # Trip info
    td = frappe.db.get_value("Trip Group Date", trip_group_date,
                             ["trip", "trip_group_name", "departure_date",
                              "max_participants", "current_participants", "status"],
                             as_dict=True)
    if not td:
        frappe.throw("Trip Group Date not found.")
    _trip = frappe.db.get_value("Trip", td.trip, ["trip_name", "is_a_cruise_trip"], as_dict=True) or {}
    trip_name = _trip.trip_name or ""
    # is_cruise: model harga/kapasiti bercabang slot (cruise) vs umur (non-cruise)
    # di _validate_selection_capacity, _build_so_items, validate_voucher & pax_type.
    is_cruise = bool(_trip.is_a_cruise_trip)

    if not trip_package:
        frappe.throw("Please select a package first.")

    # Backend pricing (dari Trip Package yang dipilih)
    pricing_map = _get_pricing_map(trip_package)

    # Sahkan had kapasiti server-side sebelum kira harga — cruise guna model
    # SLOT (Main Guest/Extra Bed/Infant), non-cruise guna model UMUR
    # (Adult/Children/Infant). cabin_info_map dari Trip Price Category.
    cabin_info_rows = frappe.db.sql("""
        SELECT tpp.pricing_for_class AS room_category,
               tpc.capacity, tpc.max_capacity
        FROM `tabTrip Package Price` tpp
        JOIN `tabTrip Price Category` tpc ON tpc.name = tpp.pricing_for_class
        WHERE tpp.parent = %s AND tpp.parenttype = 'Trip Package'
    """, trip_package, as_dict=True)
    cabin_info_map = {r.room_category: r for r in cabin_info_rows}
    _validate_selection_capacity(selections, cabin_info_map, is_cruise)

    # Jumlah pax booking NI (Main Guest + Extra Bed + Infant) — diguna untuk
    # (a) gate overbooking trip-level di bawah, dan (b) di-set sebagai
    # 'booked_pax' pada rekod Booking (sumber kebenaran gate untuk booking
    # lain kemudian). Infants DIKIRA — sepadan dengan refresh_bookings()
    # yang COUNT semua Booking Reservation row tak kira pax_type.
    incoming_pax = sum(
        int(s.get("main_guests", 0) or 0)
        + int(s.get("extra_beds", 0) or 0)
        + int(s.get("infants", 0) or 0)
        for s in selections
    )

    # Gate overbooking PERINGKAT TRIP — Trip Group Date.max_participants.
    # Peraturan: max_participants == 0 -> UNLIMITED (overbooking dibenarkan,
    # sesuai cruise tanpa had tempat duduk tetap). max_participants > 0 ->
    # jumlah pax SEMUA booking tak-cancelled untuk tarikh ni + booking semasa
    # TIDAK boleh melebihi max. Kiraan guna 'booked_pax' (stored, di-set masa
    # confirm_booking) BUKAN current_participants (yang kira Booking Reservation
    # Confirmed = bayaran dah masuk sahaja — lewat lag realiti, booking Pending
    # tak kelihatan, bolehi overbooking senyap).
    max_pax = int(td.max_participants or 0)
    if max_pax > 0:
        existing_pax = frappe.db.sql("""
            SELECT COALESCE(SUM(b.booked_pax), 0)
            FROM `tabBooking` b
            WHERE b.trip_date = %s AND b.status != 'Cancelled'
        """, trip_group_date)[0][0] or 0
        seats_left = max_pax - int(existing_pax or 0)
        if incoming_pax > seats_left:
            if seats_left <= 0:
                frappe.throw(
                    "This trip date is fully booked. Please select another date."
                )
            frappe.throw(
                "Only " + str(seats_left) + " seat(s) left on this trip date for "
                + str(incoming_pax) + " traveller(s). Please reduce your group "
                "size or select another date."
            )

    so_items    = _build_so_items(selections, pricing_map, trip_name, td.trip_group_name, is_cruise)
    grand_total = sum(float(it["rate"]) * int(it["qty"]) for it in so_items)
    pre_discount_total = grand_total  # snapshot BEFORE any voucher/referral discount — used for affiliate commission calc later

    # Voucher — hantar selections + trip_package supaya diskaun dikira ikut
    # scope (subtotal cabin yang match sahaja), bukan grand_total keseluruhan.
    voucher_discount = 0
    if voucher_code:
        vr = validate_voucher(voucher_code, trip_group_date, grand_total,
                              billing.get("email", ""), json.dumps(selections), trip_package, is_cruise)
        if vr.get("valid"):
            voucher_discount = float(vr.get("discount_amount", 0))
            grand_total = grand_total - voucher_discount
            so_items.append({
                "item_code":   _get_or_create_travel_item(),
                "item_name":   "Voucher Discount (" + voucher_code + ")",
                "qty":         1,
                "rate":        -voucher_discount,
                "uom":         "Nos",
                "description": "Voucher code: " + voucher_code,
            })

    # Referral / Affiliate — Tier B: dikira dari baki SELEPAS voucher (sepadan
    # dengan UI). Discount % kepada CUSTOMER tetap sama untuk semua trip
    # (Travel Settings). sales_partner (bukan "Affliate" — doctype tu tak
    # wujud) di-link terus ke SO di bawah, supaya hook automation app
    # 'affiliate' (create_commission_if_eligible di Sales Order.on_update)
    # dapat cipta Affiliate Commission untuk affiliate ni secara automatik.
    referral_discount = 0
    sales_partner      = None
    if affiliate_code:
        ar = validate_affiliate_code(affiliate_code, trip_group_date)
        if ar.get("valid"):
            # PENTING: sales_partner di-set di SINI SEBAIK SAHAJA kod sah
            # (tak kira discount_percent > 0 atau tidak) — attribution
            # affiliate untuk commission MESTI berlaku serta-merta bila
            # kod referral sah, berasingan sepenuhnya dari sama ada
            # customer dapat extra discount. Line item SO (di bawah) untuk
            # discount hanya ditambah kalau referral_discount > 0 — elak
            # baris "-RM0.00" yang tak bermakna pada resit/invois.
            sales_partner     = ar.get("sales_partner")
            referral_percent  = float(ar.get("discount_percent", 0))
            referral_discount = round(grand_total * (referral_percent / 100), 2)
            if referral_discount > 0:
                grand_total = grand_total - referral_discount
                so_items.append({
                    "item_code":   _get_or_create_travel_item(),
                    "item_name":   "Referral Discount (" + affiliate_code.strip().upper() + ")",
                    "qty":         1,
                    "rate":        -referral_discount,
                    "uom":         "Nos",
                    "description": "Referral code: " + affiliate_code.strip().upper(),
                })

    # Manual Transfer cashback — dikira SEBELUM SO dicipta supaya boleh
    # apply terus sebagai Additional Discount pada SO (masuk GL Entry
    # berasingan sebagai "Discount Allowed", bukan sekadar tolak nombor).
    settings = frappe.get_cached_doc("Travel Settings")
    cashback_percent = 0
    if payment_method == "Manual Transfer" and settings.manual_transfer_cashback_enabled:
        cashback_percent = float(settings.manual_transfer_cashback_percent or 0)

    # Delivery Date = sehari SEBELUM tarikh berlepas — SO "kena complete"
    # (dari segi expected fulfilment ERPNext) sebelum trip bermula. Fallback
    # ke hari ini kalau departure_date somehow kosong (elak SO gagal insert).
    if td.departure_date:
        delivery_date = frappe.utils.add_days(td.departure_date, -1)
    else:
        delivery_date = frappe.utils.today()

    # SO sentiasa dalam COMPANY CURRENCY — harga pakej disimpan & dimasukkan
    # dalam company currency (keputusan senibina: workflow jualan/booking
    # SEMUA dalam company currency; paparan currency lain diuruskan di layer
    # display converter frontend, BUKAN di SO/accounting). conversion_rate=1.0
    # kerana SO currency == company currency. Ini juga membuang kebergantungan
    # pada rekod Currency Exchange untuk penciptaan booking — booking TIDAK
    # gagal walaupun rate exchange belum diisi admin (rate hanya diperlukan
    # untuk DISPLAY converter, bukan untuk accounting transaksi).
    company_currency = get_company_currency()
    so_conversion_rate = 1.0

    # Sales Order — insert & submit sebagai Administrator (elak isu permission
    # customer terhadap Link field dalaman seperti Account semasa validate SO).
    _original_user = frappe.session.user
    frappe.set_user("Administrator")
    try:
        so_payload = {
            "doctype":            "Sales Order",
            "customer":           customer_name,
            "transaction_date":   frappe.utils.today(),
            "delivery_date":      delivery_date,
            "order_type":         "Sales",
            "items":              so_items,
            "selling_price_list": "Standard Selling",
            # SO dalam company currency, conversion_rate=1.0 (lihat nota di atas).
            "currency":           company_currency,
            "conversion_rate":    so_conversion_rate,
            # PENTING: matikan pembundaran ke ringgit-penuh untuk SO booking.
            # Tanpa ni, ERPNext boleh bundar grand_total (cth RM9.50) ke
            # rounded_total (cth RM10.00) — sedangkan jumlah SEBENAR yang
            # dicaj/dibayar customer (Stripe/manual transfer/Payment Entry)
            # sentiasa ikut grand_total tepat. Jurang ni punca SO kekal
            # "ada baki" (Rounding Adjustment) walaupun booking dah settle
            # penuh dari segi bisnes. Bayaran kita semua elektronik (Stripe/
            # bank transfer) — tiada keperluan bundar ringgit-penuh macam
            # transaksi tunai fizikal.
            #
            # NOTA: "Disable Rounded Total" kini turut dihidupkan SECARA
            # GLOBAL di Selling Settings — flag di sini kekal (defence-in-
            # depth untuk SO ni khusus, tak bergantung semata-mata pada
            # setting global yang admin boleh terlupa/tersilap toggle),
            # tapi puncanya sekarang global — semua SO (termasuk addon
            # yang admin cipta manual di Desk) turut terjamin
            # rounded_total=0, jadi seluruh app boleh standardize terus
            # ke grand_total sahaja (rujuk juga booking.py properties,
            # portal_booking.py, portal_payment.py, stripe_checkout.py).
            "disable_rounded_total": 1,
        }
        if sales_partner:
            so_payload["sales_partner"] = sales_partner
        if sales_persons:
            # Optional — staff dalaman RareCruise yang uruskan booking ni,
            # boleh lebih dari SATU (customer tambah melalui "+ Add
            # another" di wizard). Disimpan terus dalam SO's child table
            # 'Sales Team' sahaja (bukan Booking doctype).
            #
            # NOTA PENTING: ERPNext ENFORCE "Total allocated percentage for
            # sales team should be 100" semasa simpan Sales Order — kita
            # TAK BOLEH biarkan allocated_percentage kosong/0 macam rancangan
            # asal (admin tak boleh isi sendiri lepas ni sebab SO gagal
            # simpan dari awal). Jadi kita auto-bahagi SAMA RATA merentasi
            # semua sales person dipilih — customer tak nampak/isi peratus
            # ni langsung, cuma teknikal untuk penuhi validation ERPNext.
            # Admin boleh edit manual di Desk kemudian kalau nak nisbah lain.
            sp_list = sales_persons
            if isinstance(sp_list, str):
                sp_list = json.loads(sp_list)
            sp_list = [sp for sp in (sp_list or []) if sp]  # buang kosong/duplikat
            sp_list = list(dict.fromkeys(sp_list))
            if sp_list:
                n = len(sp_list)
                base_pct = round(100.0 / n, 2)
                rows = []
                for i, sp in enumerate(sp_list):
                    # Baris terakhir dapat baki supaya jumlah TEPAT 100.00
                    # (elak ralat float, cth 3 orang: 33.33+33.33+33.34=100).
                    pct = base_pct if i < n - 1 else round(100.0 - base_pct * (n - 1), 2)
                    rows.append({"sales_person": sp, "allocated_percentage": pct})
                so_payload["sales_team"] = rows
        if cashback_percent > 0:
            if not settings.cashback_discount_account:
                frappe.throw("Cashback Discount Account is not set in Travel Settings.")
            so_payload.update({
                "apply_discount_on":              "Grand Total",
                "additional_discount_percentage": cashback_percent,
                "additional_discount_account":    settings.cashback_discount_account,
            })

        # PENTING: item 'TRAVEL-PKG' dikongsi untuk SEMUA jenis pax (Main
        # Guest/Extra Bed/Infant/Voucher/Referral) dengan rate berbeza-beza
        # setiap baris — ERPNext punya insert_item_price() automatik
        # "kemaskini" Item Price pada Price List "Standard Selling" setiap
        # kali rate SO Item tak sepadan dengan rate tersimpan, dan
        # frappe.msgprint() sekali untuk setiap baris ("Item Price updated
        # for TRAVEL-PKG..."). Mesej ni TIDAK BERBAHAYA (bukan error), tapi
        # ia bocor masuk response API sebagai _server_messages, dan boleh
        # disalah anggap sebagai error oleh sebarang caller yang tak teliti
        # (rujuk fix di public/js/booking.js apiCall()). Kita redakan
        # sepenuhnya di sini — simpan panjang frappe.message_log SEBELUM,
        # pangkas balik ke panjang asal SELEPAS — supaya msgprint yang
        # timbul dalam window insert/submit ni tak sampai ke response,
        # tanpa ganggu logik ERPNext sendiri (Item Price tetap dikemaskini
        # macam biasa, cuma notifikasi visualnya yang disekat).
        _msg_log_len_before = len(frappe.message_log)

        so = frappe.get_doc(so_payload)
        so.insert(ignore_permissions=True)
        so.flags.ignore_permissions = True
        so.submit()

        del frappe.message_log[_msg_log_len_before:]
    finally:
        frappe.set_user(_original_user)

    # Guna grand_total SEBENAR dari SO (selepas additional discount, jika ada)
    # supaya deposit/full-payment dikira dari jumlah yang betul-betul perlu
    # dibayar. "Disable Rounded Total" kini global (Selling Settings) — SO
    # ni (dan semua SO lain dalam app) tak lagi ada rounded_total berlainan
    # dari grand_total, jadi guna grand_total terus tanpa fallback.
    grand_total = float(so.grand_total or 0)

    # Deposit calc
    if amount_paid is not None:
        amount_paid = float(amount_paid)
    default_deposit_percent = float(settings.default_deposit_percent or 20)
    std_deposit    = round(grand_total * (default_deposit_percent / 100), 2)
    deposit_amount = amount_paid if amount_paid is not None else (std_deposit if payment_type == "Deposit" else grand_total)

    if amount_paid is not None and abs(amount_paid - grand_total) < 0.01:
        payment_type = "Full Payment"
    elif amount_paid is not None:
        payment_type = "Deposit"

    # Semua booking mula sebagai "Pending" (belum bayar langsung). Bila
    # bayaran PERTAMA masuk (Partially Paid atau Paid), status auto-tukar
    # ke "Accepted" (rujuk _recompute_booking_status()). Reservation TIDAK
    # dicipta di sini — dicipta bila payment_status jadi "Paid" (melalui
    # hook Payment Entry). Flight & stateroom di-assign admin secara manual
    # kemudian (isian tu yang trigger status "Processing").
    booking = frappe.get_doc({
        "doctype":        "Booking",
        "trip_date":      trip_group_date,
        "trip_package":   trip_package,
        "customer":       customer_name,
        "status":         "Pending",
        "payment_status": "Pending",
        "booking_number": _generate_booking_number(),
        "booked_pax":     incoming_pax,
        # PENTING: attribution affiliate (untuk commission) TAK bergantung
        # pada referral_discount > 0 — sales_partner dah sah (atau None)
        # ditentukan di atas terus dari validate_affiliate_code(), jadi
        # guna terus di sini tanpa syarat tambahan.
        "affiliate":            sales_partner,
        "pre_discount_total":   pre_discount_total,
        # SNAPSHOT email pada masa booking dicipta — SENGAJA bukan field
        # virtual/live (beza dari get_cust_phone yang live-compute dari
        # Contact). Kalau customer tukar email Contact mereka kemudian
        # (cth via portal), Booking lama ni KEKAL papar email asal yang
        # digunakan masa booking dibuat — rekod sejarah/audit trail, bukan
        # rujukan "terkini".
        "cust_email":           email,
    })
    booking.insert(ignore_permissions=True)

    # Portal access — cipta User serentak dengan Booking (bukan lazy-created
    # bila customer minta login link). Kalau email ni dah ada User (returning
    # customer), tak buat apa-apa — reuse User sedia ada.
    is_new_user = _ensure_portal_user(email, customer_name)
    if is_new_user:
        # Emel "Set Your Password" BERASINGAN, dihantar SEKALI SAHAJA di
        # sini — tak kira payment method atau status booking pertama
        # customer (Pending/Accepted/dsb). Lebih mudah & selamat dari
        # cuba sertakan pautan ni ke dalam emel status pertama (yang mana
        # laluan trigger emel status pertama berbeza-beza ikut payment
        # method/hasil bayaran — mudah tersasar, rujuk sejarah bug).
        full_name  = billing.get("full_name") or "Customer"
        first_name = full_name.split()[0] if full_name else "Customer"
        _send_set_password_email(email, first_name)

    # SO utama dikaitkan SEMATA-MATA melalui Sales Order.custom_booking (one-
    # standard: SO rujuk Booking, bukan dua-hala). SO dicipta SEBELUM Booking
    # wujud, jadi baru boleh diisi sekarang selepas booking.name ada.
    frappe.db.set_value("Sales Order", so.name, "custom_booking", booking.name)

    res_created = 0  # dicipta bila Confirmed (hook Payment Entry)

    if voucher_code and voucher_discount > 0:
        # PENTING: 'voucher_usage' TIDAK disimpan pada Booking — field ni
        # dah dibuang dari schema Booking (rujukan cepat lama, sebelum
        # Voucher Usage jadi doctype standalone). Rekod Voucher Usage
        # sebenar masih wujud (dicipta oleh _use_voucher() di bawah,
        # dikesan semula melalui filter {"booking": booking_name} bila
        # perlu — rujuk _release_voucher_for_booking()) — cuma Booking
        # sendiri tak simpan Link terus ke rekod tu lagi.
        used_voucher_name, _used_voucher_usage_name = _use_voucher(
            voucher_code, customer_name, booking.name, voucher_discount
        )
        if used_voucher_name:
            frappe.db.set_value("Booking", booking.name, {"voucher": used_voucher_name})

    # Online Payment → jana Stripe payment URL (bayar ikut payment_type: deposit/full)
    # PENTING: emel "Pending" TIDAK dihantar di sini untuk Online Payment.
    # Kalau bayaran berjaya serta-merta, webhook terus hantar emel "Accepted"
    # (lompat terus, elak customer dapat 2 emel berturut-turut untuk satu
    # tindakan). Emel "Pending" untuk Online Payment hanya dihantar oleh:
    #   (a) webhook payment_intent.payment_failed (Stripe confirm gagal), atau
    #   (b) checkout.html punya timeout 5 minit (customer tak siapkan bayaran)
    # — kedua-dua di stripe_checkout.py, guna _send_status_email() yang sama.
    payment_url = ""
    if payment_method == "Online Payment":
        pay_amount = deposit_amount if payment_type == "Deposit" else grand_total
        payment_url = _create_payment_url(
            customer_name = customer_name,
            so_name       = so.name,
            amount        = pay_amount,
            booking_number = booking.booking_number,
        )
    elif payment_method == "Manual Transfer" and receipt:
        _create_manual_payment_entry(
            so_name       = so.name,
            customer_name = customer_name,
            amount        = deposit_amount,
            receipt_data  = receipt,
            label         = "receipt-" + booking.booking_number,
            bank_transfer_ref = bank_transfer_ref,
        )
    elif payment_method == "Pay Later":
        # Tiada bayaran cuba dibuat sekarang — SO + Booking dah cipta
        # (grand_total penuh, advance_paid=0) macam biasa di atas, cuma
        # SKIP terus penciptaan Payment Entry/Stripe URL. Customer bayar
        # KEMUDIAN melalui portal (mekanisme sedia ada — tab Payment &
        # Invoice, "Pay Now" — tiada perubahan diperlukan di situ).
        # Booking Reservation TIDAK dicipta serta-merta (rujuk
        # _recompute_booking_status(): trigger bergantung payment_status
        # mula ada bayaran — kekal begitu, keputusan sengaja).
        pass

    frappe.db.commit()

    if payment_method in ("Manual Transfer", "Pay Later"):
        # Manual Transfer — booking betul-betul "Pending" (menunggu admin
        # verify resit). Pay Later — booking "Pending" sebab memang belum
        # ada bayaran langsung. Kedua-dua kongsi mesej/template EMAIL yang
        # sama ("Booking Pending") — keputusan sengaja, elak template
        # baharu buat masa ni. (Wizard memaksa upload resit untuk Manual
        # Transfer sebelum submit, tapi check ni tak bergantung pada
        # 'receipt' supaya tetap selamat kalau dipanggil terus via API.)
        _send_status_email(booking.name, "Pending",
                           email_override=billing.get("email", ""))

    return {
        "success":        True,
        "booking":        booking.name,
        "booking_number": booking.booking_number,
        "sales_order":    so.name,
        "grand_total":    grand_total,
        "amount_due":     deposit_amount,
        "reservations_created": res_created,
        "booking_status": booking.status,
        "payment_status": _compute_payment_status(0, grand_total),
        "advance_paid":   0,
        "payment_type":   payment_type,
        "payment_method": payment_method,
        "payment_url":    payment_url,
        "cashback_percent": cashback_percent,
        "cashback_amount":  round(so.discount_amount, 2) if cashback_percent > 0 else 0,
        "voucher_discount":  round(voucher_discount, 2),
        "referral_discount": round(referral_discount, 2),
    }


# ══════════════════════════════════════════════
# STATUS ENGINE
# ══════════════════════════════════════════════

def _recompute_booking_status(so_name):
    """Kira semula payment_status dari GABUNGAN SEMUA SO yang berkaitan
    booking (SO utama + SO addon seperti excursion/servis tambahan yang
    admin create berasingan, dikaitkan melalui Sales Order.custom_booking).

    PENTING (flow status baharu):
    - "Pending" -> "Accepted": auto, sebaik bayaran PERTAMA masuk (Partially
      Paid atau Paid) — booking baru mula sebagai "Pending" (belum bayar).
    - "Accepted" -> "Processing"/"Confirmed": TIDAK berlaku di sini —
      peralihan ni kini MANUAL sepenuhnya (admin pilih terus value baharu
      di field status Booking di Desk; rujuk on_booking_update()).
    - "Cancelled" tetap sticky (status di-skip, tapi payment_status tetap
      dikemaskini supaya rekod bayaran refund/partial kekal tepat).
    """
    booking_name = _resolve_booking_from_so(so_name)
    if not booking_name:
        return

    all_so_names = _get_all_booking_sales_orders(booking_name)
    if not all_so_names:
        return

    # NOTA: "Disable Rounded Total" kini global (Selling Settings) — semua
    # SO berkaitan booking tak lagi ada rounded_total berlainan dari
    # grand_total, jadi standardize ke grand_total sahaja.
    total = 0
    paid  = 0
    for name in all_so_names:
        so = frappe.db.get_value("Sales Order", name, ["grand_total", "advance_paid"], as_dict=True)
        if so:
            total += float(so.grand_total or 0)
            paid  += so.advance_paid or 0

    new_payment_status = _compute_payment_status(paid, total)

    # prog_payment: peratusan kemajuan bayaran, formula (1 - (balance/total))
    # * 100 — field STORED sebenar (bukan @property macam total_amount/
    # balance_amount), jadi WAJIB ditulis eksplisit di sini setiap kali
    # payment data SO berkaitan berubah (bukan dikira on-the-fly semasa
    # baca), supaya sentiasa terkini untuk paparan List View/laporan.
    balance = max(0, total - paid)
    new_prog_payment = round((1 - (balance / total)) * 100) if total > 0 else 0

    b = frappe.db.get_value("Booking", booking_name, ["name", "status", "payment_status", "prog_payment"], as_dict=True)
    if not b:
        return

    if b.prog_payment != new_prog_payment:
        frappe.db.set_value("Booking", b.name, "prog_payment", new_prog_payment)

    # Reservation dicipta sebaik payment_status mula ada sebarang bayaran
    # (Partially Paid ATAU Paid) — bukan perlu tunggu Paid penuh. Ini
    # sepadan dengan _activate_booking() sendiri idempotent (check dulu
    # kalau Reservation dah wujud), jadi selamat panggil berulang.
    had_any_payment = b.payment_status in ("Partially Paid", "Paid")

    if b.payment_status != new_payment_status:
        frappe.db.set_value("Booking", b.name, "payment_status", new_payment_status)

    if b.status == "Cancelled":
        return  # sticky — status tak berubah walau bayaran berubah

    # Pending -> Accepted: auto, sebaik bayaran PERTAMA masuk. Email
    # "Accepted" dihantar HANYA pada transisi ni (bila status memang
    # "Pending" sebelum ni) — bukan setiap kali _recompute dipanggil.
    if new_payment_status in ("Partially Paid", "Paid") and b.status == "Pending":
        frappe.db.set_value("Booking", b.name, "status", "Accepted")
        _send_status_email(b.name, "Accepted")

    # Reservation dicipta sebaik payment_status mula ada sebarang bayaran —
    # TIDAK bergantung pada status booking (Processing/Confirmed kini
    # ditetapkan admin secara manual, bukan auto dari sini).
    if new_payment_status in ("Partially Paid", "Paid") and not had_any_payment:
        _activate_booking(b.name)

   # Auto-invoice — SENGAJA berasingan dari new_payment_status di atas.
    # new_payment_status tu peringkat BOOKING (agregat SEMUA SO berkaitan
    # booking — utama + addon). Auto-invoice pula per-SO INDEPENDENT (satu
    # SO addon settle tak tunggu SO utama settle juga, atau sebaliknya) —
    # jadi perlu check terus status bayaran SO ni SENDIRI, bukan agregat.
    _maybe_auto_invoice_so(so_name)

    # Booking Addon Order — kalau SO ni ialah SO addon (bukan SO cabin
    # utama), refresh payment_status/status order tu SENDIRI (per-SO,
    # BUKAN agregat booking — rujuk nota reka bentuk addon/insurance:
    # order addon yang dah fully paid tak patut nampak "belum paid" sebab
    # baki SO cabin lain belum settle). Guard frappe.db.exists() elak
    # error kalau addon feature belum di-deploy (doctype belum wujud lagi
    # semasa migration progresif).
    if frappe.db.exists("DocType", "Booking Addon Order"):
        addon_order_name = frappe.db.get_value("Booking Addon Order", {"sales_order": so_name}, "name")
        if addon_order_name:
            frappe.get_doc("Booking Addon Order", addon_order_name).refresh_payment_status()


# ══════════════════════════════════════════════
# CANCEL CASCADE
# ══════════════════════════════════════════════

def _cancel_booking_cascade(booking_doc):
    """Bila booking Cancelled: reservation -> Inactive, lepas voucher,
    cancel SEMUA SO berkaitan (utama + addon) yang belum bayar (kalau dah
    bayar, log utk refund manual — SO tu KEKAL, tak di-cancel). Kalau ada
    bayaran sedia ada, payment_status ditukar ke "Request Refund" supaya
    admin nampak booking ni perlukan proses refund (Pending Refund/Refunded
    ditetapkan admin secara manual selepas refund diproses melalui bank/Stripe).
    """
    for r in frappe.get_all("Booking Reservation",
                            filters={"booking": booking_doc.name, "status": "Confirmed"},
                            fields=["name"]):
        res = frappe.get_doc("Booking Reservation", r.name)
        res.status = "Cancelled"
        res.save(ignore_permissions=True)

    _release_voucher_for_booking(booking_doc.name)

    total_paid = 0
    for so_name in _get_all_booking_sales_orders(booking_doc.name):
        so = frappe.db.get_value("Sales Order", so_name,
                                 ["advance_paid", "docstatus"], as_dict=True)
        if not so:
            continue
        total_paid += so.advance_paid or 0
        if (so.advance_paid or 0) <= 0 and so.docstatus == 1:
            try:
                so_doc = frappe.get_doc("Sales Order", so_name)
                so_doc.flags.ignore_permissions = True
                so_doc.cancel()
            except Exception as e:
                frappe.log_error("Cancel SO failed " + so_name + ": " + str(e), "Booking Cancel")
        elif (so.advance_paid or 0) > 0:
            frappe.log_error(
                "Booking " + booking_doc.name + " cancelled but SO " + so_name +
                " has payment RM" + str(so.advance_paid) + ". Refund & cancel SO requires manual action.",
                "Booking Cancel - Refund Needed")

    if total_paid > 0:
        frappe.db.set_value("Booking", booking_doc.name, "payment_status", "Request Refund")


# ══════════════════════════════════════════════
# DOC EVENT HOOKS (dipanggil oleh hooks.py doc_events)
# ══════════════════════════════════════════════

def on_payment_entry_submit(doc, method=None):
    """Hook: Payment Entry submit → resit + kemas kini status booking + cipta reservation.
    Berfungsi untuk Payment Entry terhadap SO UTAMA mahupun SO ADDON — kedua-dua
    diselesaikan balik ke Booking yang sama melalui _resolve_booking_from_so().
    """
    _send_receipt_email(doc)  # resit setiap bayaran (runcit-runcit pun dapat bukti)
    for ref in (doc.references or []):
        if ref.reference_doctype == "Sales Order" and ref.reference_name:
            _recompute_booking_status(ref.reference_name)


def on_payment_entry_cancel(doc, method=None):
    """Hook: Payment Entry cancel → kira semula status booking."""
    for ref in (doc.references or []):
        if ref.reference_doctype == "Sales Order" and ref.reference_name:
            _recompute_booking_status(ref.reference_name)


def on_booking_update(doc, method=None):
    """Hook: Booking.on_update — kesan peralihan status yang dibuat MANUAL
    oleh admin di Desk (pilih value baharu terus di field 'status'), dan
    hantar email sepadan. Turut kesan peralihan ke 'Cancelled' untuk
    jalankan cascade.

    PENTING: "Pending" -> "Accepted" TIDAK dikesan di sini — peralihan tu
    automatik ikut bayaran (rujuk _recompute_booking_status(), dipanggil
    dari hook Payment Entry), bukan admin pilih terus di dropdown. Begitu
    juga "Completed" (auto ikut tarikh trip, rujuk mark_completed_trips()).
    Fungsi ni HANYA kesan dua peralihan MANUAL: ke "Processing" dan ke
    "Confirmed" (admin pilih terus value baharu di field status), serta
    peralihan ke "Cancelled" (boleh manual atau dari mana-mana laluan lain).
    """
    old = doc.get_doc_before_save()
    if not old or old.status == doc.status:
        return  # tiada perubahan status — tak perlu buat apa-apa

    if doc.status == "Cancelled":
        _cancel_booking_cascade(doc)
    elif doc.status == "Processing" and old.status != "Processing":
        _send_status_email(doc.name, "Processing")
    elif doc.status == "Confirmed" and old.status != "Confirmed":
        _send_status_email(doc.name, "Confirmed")


# ══════════════════════════════════════════════
# SCHEDULED TASK
# ══════════════════════════════════════════════

def mark_completed_trips(booking_name=None):
    """Scheduled task (harian, rujuk hooks.py scheduler_events) — auto-tukar
    status booking ke 'Completed' selepas tarikh berlepas (departure_date)
    trip berlalu. Hanya booking yang 'Confirmed' layak (booking yang tak
    sempat Confirmed sebelum trip bermula TIDAK di-auto-complete — perlu
    semakan manual admin). booking_name (opsyenal) untuk test/panggil manual
    terhadap satu booking sahaja.
    """
    params = {"today": frappe.utils.today()}
    extra_filter = ""
    if booking_name:
        extra_filter = "AND b.name = %(booking_name)s"
        params["booking_name"] = booking_name

    bookings = frappe.db.sql("""
        SELECT b.name
        FROM `tabBooking` b
        JOIN `tabTrip Group Date` td ON td.name = b.trip_date
        WHERE b.status = 'Confirmed'
          AND td.departure_date IS NOT NULL
          AND td.departure_date < %(today)s
          {extra}
    """.format(extra=extra_filter), params, as_dict=True)

    for b in bookings:
        try:
            frappe.db.set_value("Booking", b.name, "status", "Completed")
            _send_status_email(b.name, "Completed")
        except Exception as e:
            frappe.log_error(
                "Failed to auto-complete booking " + b.name + ": " + str(e),
                "Booking Auto-Complete Error"
            )
    frappe.db.commit()


# ══════════════════════════════════════════════
# BOOKING NUMBER + PORTAL USER
# ══════════════════════════════════════════════

def _generate_booking_number():
    while True:
        suffix = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        booking_number = "RC" + suffix
        if not frappe.db.exists("Booking", {"booking_number": booking_number}):
            return booking_number


def _ensure_portal_user(email, customer_name):
    """Cipta User portal serentak dengan Booking (kalau belum wujud untuk
    email ni). Password diisi random placeholder — TIDAK PERNAH didedahkan
    kepada customer secara langsung (tiada raw password dalam emel).
    Customer sentiasa masuk portal melalui pautan "Set Your Password"
    (reset_password_key, hantar sekali dalam emel booking pertama) atau
    Magic Link (login page). Pulangkan True kalau User baru dicipta.
    """
    email = (email or "").strip().lower()
    if not email:
        return False
    if frappe.db.exists("User", email):
        return False

    customer_full_name = frappe.db.get_value("Customer", customer_name, "customer_name") or customer_name
    first_name = customer_full_name.split()[0] if customer_full_name else "Customer"
    last_name  = " ".join(customer_full_name.split()[1:]) if len(customer_full_name.split()) > 1 else ""

    new_user = frappe.get_doc({
        "doctype":            "User",
        "email":              email,
        "first_name":         first_name,
        "last_name":          last_name,
        "enabled":            1,
        "user_type":          "Website User",
        "send_welcome_email": 0,
        "new_password":       frappe.generate_hash(length=16),
        "roles":              [{"role": "Traveller"}]
    })
    new_user.flags.ignore_permissions = True
    new_user.flags.ignore_password_policy = True
    new_user.insert()
    frappe.db.commit()
    return True
