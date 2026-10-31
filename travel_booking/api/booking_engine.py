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
from frappe import _
import json
import random
from datetime import date as datetime_date  # untuk delivery date comparison
from datetime import datetime
import string

from travel_booking.api._helpers import (
    get_customer_by_email,
    get_company_currency,
    get_own_affiliate_code,
    resolve_booking_actor,
    standardize_phone_to_hyphen,
    _as_bool,
)
from travel_booking.api.pricing import (
    _get_pricing_map,
    _price_selection,
    _validate_selection_capacity,
)
from travel_booking.api.price_rule import (
    apply_price_rules,
    resolve_ctx,
    rule_snapshot,
)
from travel_booking.api.so_helpers import (
    _create_customer,
    _upsert_customer_billing_address,
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
    _resolve_so_currency_and_rate,
    _resolve_cashback_discount_account,
    _safe_date as _safe_transfer_date,
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
from travel_booking.api.terms import get_active_terms_record
from travel_booking.api.cabin_sharing import _activate_share_traveller_reservation
from travel_booking.api.constants import TRAVEL_ITEM_CODE


# ══════════════════════════════════════════════
# 7. CONFIRM BOOKING
# ══════════════════════════════════════════════

def _resolve_b2b_discount_percent(partner_name, trip_package):
    """Diskaun % partner untuk satu pakej — harga net B2B (deducted
    price). Override khusus pakej (Travel B2B Package Discount) mengatasi
    default partner. Pulang 0 kalau tiada konfigurasi (harga penuh).
    Bukan endpoint — helper dalaman confirm_booking().
    """
    override = frappe.db.get_value(
        "Travel B2B Package Discount",
        {"parent": partner_name, "parenttype": "Travel B2B Partner",
         "trip_package": trip_package},
        "discount_percent",
    )
    if override is not None:
        return float(override or 0)
    return float(
        frappe.db.get_value(
            "Travel B2B Partner", partner_name, "default_discount_percent"
        ) or 0
    )


@frappe.whitelist()
def get_b2b_discount_percent(trip_package: str):
    """Peratus harga net B2B untuk session user (staf partner) bagi SATU
    pakej — untuk PAPARAN ringkasan harga di wizard sahaja (supaya staf
    partner nampak jumlah net, bukan harga runcit). Angka sebenar diresolusi
    SEMULA secara authoritative dalam confirm_booking() — nilai client tidak
    pernah dipercayai. Pulang {"discount_percent": 0} untuk user bukan
    partner (customer biasa/Guest) supaya wizard kekal papar harga penuh.
    """
    actor = resolve_booking_actor()
    if not actor or actor.get("channel") != "B2B" or not trip_package:
        return {"discount_percent": 0, "partner_name": ""}
    return {
        "discount_percent": _resolve_b2b_discount_percent(
            actor["partner"], trip_package
        ),
        "partner_name": actor.get("partner_name") or "",
    }


def _price_rules_json(applied_price_info, rule_ctx):
	"""Snapshot JSON Travel Price Rule yang menang, untuk field Booking
	.applied_price_rules (audit trail promosi pada masa booking)."""
	snap = rule_snapshot(applied_price_info, rule_ctx.get("currency"))
	return frappe.as_json(snap) if snap else None


@frappe.whitelist(allow_guest=True)
def confirm_booking(trip_group_date: str, selections: str, billing: str,
                    payment_type: str = "Full Payment", payment_method: str = "Online Payment",
                    receipt: str = None, voucher_code: str = "", affiliate_code: str = "", amount_paid: float = None,
                    trip_package: str = None, sales_persons: str = None, bank_transfer_ref: str = None,
                    bank_transfer_date: str = "", bank_transfer_note: str = "",
                    booking_number: str = None, on_behalf: bool = False,
                    terms_accepted: bool = False, terms_reference: str = "",
                    customer_message: str = ""):
    if isinstance(selections, str):
        selections = json.loads(selections)
    if isinstance(billing, str):
        billing = json.loads(billing)

    email = billing.get("email", "").strip().lower()

    # ── BILLING ADDRESS — WAJIB untuk tujuan bil/invois ──────────────────
    # Wizard /booknow (Step 2) menghantar 5 medan alamat; disahkan semula
    # di sini supaya panggilan terus ke API (memintas frontend) tidak boleh
    # cipta booking tanpa alamat billing. Nilai di-trim dan ditulis balik
    # supaya Address 'Billing' customer di bawah sentiasa terima data bersih.
    address_labels = {
        "address_line1": "Street Address",
        "city":          "City",
        "postcode":      "Postcode",
        "state":         "State",
        "country":       "Country",
    }
    for _field in address_labels:
        billing[_field] = (billing.get(_field) or "").strip()
    _missing_address = [
        label for _field, label in address_labels.items() if not billing[_field]
    ]
    if _missing_address:
        frappe.throw(
            "Please complete your billing address: "
            + ", ".join(_missing_address) + "."
        )

    bank_transfer_ref = (bank_transfer_ref or "").strip()
    # Tarikh transaksi bank (YYYY-MM-DD — format internal sistem) + nota
    # customer tentang transaksi. Tarikh disahkan getdate (input date HTML
    # sudah ISO, tapi panggilan API terus boleh hantar apa-apa); nota
    # dihad 500 aksara selari medan portal billing.
    bank_transfer_date = _safe_transfer_date(bank_transfer_date)
    bank_transfer_note = (bank_transfer_note or "").strip()[:500]
    # Form-encoded POST menghantar boolean sebagai string "true"/"false" —
    # Python merawat KEDUA-DUA string tu sebagai truthy, jadi WAJIB
    # normalize sebelum diguna (rujuk _as_bool di _helpers.py).
    on_behalf = _as_bool(on_behalf)

    # ── TERMS & CONDITIONS (gate + snapshot persetujuan) ─────────────────
    # Wizard /booknow memaparkan dokumen T&C yang dipilih dalam Travel
    # Settings (doctype standard "Terms and Conditions") di Step 3 dan
    # memaksa tick persetujuan sebelum Pay Now. Di sini gate disahkan SEMULA
    # server-side supaya panggilan terus ke API (memintas frontend) tak
    # boleh cipta booking tanpa persetujuan, dan supaya dokumen T&C yang
    # diterima sentiasa dokumen yang DIPILIH semasa confirm (bukan dokumen
    # lain/lapuk). Bila tiada pilihan di Travel Settings (atau dokumen
    # di-disabled), gate dilangkau — rollout berperingkat tanpa mematikan
    # booking.
    terms_accepted = _as_bool(terms_accepted)
    terms_reference = (terms_reference or "").strip()
    customer_message = (customer_message or "").strip()[:2000]
    active_terms = get_active_terms_record()
    if active_terms:
        if not terms_accepted:
            frappe.throw(
                _("Please read and accept the Terms & Conditions before confirming your booking."),
                title="Terms Not Accepted",
            )
        if terms_reference != active_terms.name:
            frappe.throw(
                _("The Terms & Conditions have changed. Please refresh the page and accept the latest version before continuing."),
                title="Terms Version Outdated",
            )

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

    # ── BOOKING ON BEHALF (fasa 1 — modul booking-channel) ──────────────
    # Session user dengan role Affiliate / Sales User yang menanda
    # on_behalf=True di wizard BOLEH langkau OTP email customer — 3rd
    # party ter-authenticate inilah yang "vouch" email tersebut. Nilai
    # on_behalf dari client TIDAK dipercayai begitu sahaja: IANYA hanya
    # berkesan bila resolve_booking_actor() mengesahkan session semasa
    # benar-benar memiliki role yang layak. Guest / user biasa yang
    # menghantar on_behalf=true secara manual akan terus jatuh kepada
    # gate OTP biasa di bawah — tiada pintu belakang.
    booking_actor = resolve_booking_actor() if on_behalf else None
    session_user  = frappe.session.user if frappe.session.user != "Guest" else None

    # ── SALURAN B2B (agen / reseller) ────────────────────────────────────
    # Staf partner (Travel B2B Partner User) tempah bagi pihak pelanggan
    # mereka: Sales Order & billing KESELURUHANNYA atas Customer partner
    # (harga net — diskaun % partner), end-customer hanya dapat akses
    # portal traveller (status/dokumen, tanpa harga). Rujuk _helpers.
    is_b2b = bool(booking_actor and booking_actor.get("channel") == "B2B")
    if is_b2b:
        # Harga net partner ialah harga kontrak — voucher / referral
        # discount TIDAK BOLEH ditindankan atasnya.
        if voucher_code:
            frappe.throw(
                _("Voucher codes cannot be applied to B2B partner bookings.")
            )
        if affiliate_code:
            frappe.throw(
                _("Referral codes cannot be applied to B2B partner bookings.")
            )

    # ── PRE-AKTIVASI AFFILIATE (profil affiliate session user) ──────────
    # User yang melengkapkan order di wizard /booknow yang didapati ada
    # profil affiliate yang SAH (Affiliate Profile status "Verified"
    # milik session user sendiri — rujuk get_own_affiliate_code())
    # booking-nya di-PRA-AKTIFKAN dengan kod referral DIA SENDIRI:
    # attribution sales_partner di bawah (SO + Booking.affiliate) dan
    # automation komisen app 'affiliate' berjalan tanpa dia perlu taip
    # kod itu manual di wizard.
    # Dikecualikan:
    #   - kod EKSPLISIT dari client (URL ?sp= / cookie rc_aff / taipan
    #     manual — kod affiliate lain sentiasa diutamakan; pre-aktivasi
    #     ini cuma DEFAULT, bukan override), dan
    #   - saluran B2B — kod referral memang dilarang atas harga net
    #     kontrak partner (guard throw di atas).
    if not affiliate_code and not is_b2b and session_user:
        affiliate_code = get_own_affiliate_code(session_user) or ""

    if not booking_actor and not has_portal_user and not is_verified:
        frappe.throw(
            "Your email verification session has expired (30 minutes). "
            "Please request a new OTP code and verify again to continue your booking."
        )

    # ════════════════════════════════════════════════════════════
    # CANCEL BOOKING LAMA (re-confirm selepas "Back" dari checkout)
    # ════════════════════════════════════════════════════════════
    # booking_number datang dari wizard state yang di-restored — customer
    # tekan "Back" di checkout.html, kembali ke wizard, tukar kaedah
    # bayaran, dan re-confirm. Cancel booking lama (Pending, tiada bayaran)
    # supaya tidak berlaku duplicate booking. Hanya cancel jika status
    # masih "Pending" (belum dibayar) — booking yang dah dibayar perlukan
    # refund manual oleh admin, tidak boleh di-auto-cancel.
    # PENTING: `booking_number` ialah FIELD berasingan (cth "RTEOU462609"),
    # BUKAN docname Booking (dijana naming_series cth "BK-xxx"). Lookup
    # mesti guna field booking_number — frappe.db.exists("Booking", bn)
    # semak docname sahaja dan sentiasa return False (bug lama: seluruh
    # cancel-on-re-confirm path tak pernah berjalan, menyebabkan redundant
    # booking bertinduk bila customer Back dari checkout & tukar kaedah).
    _old_booking_name = None
    if booking_number:
        _old_booking_name = frappe.db.get_value(
            "Booking", {"booking_number": booking_number}, "name"
        )
    if _old_booking_name:
        _old_status = frappe.db.get_value("Booking", _old_booking_name, "status")
        if _old_status == "Pending":
            # Cancel Payment Request Stripe dahulu untuk SETIAP SO booking
            # lama — PR yang masih "Requested" (customer Back dari checkout)
            # perlu dibersihkan supaya SO baharu tidak tersekat oleh PR yatim.
            for _old_so in _get_all_booking_sales_orders(_old_booking_name):
                _cancel_payment_requests_for_so(_old_so)
            _old_doc = frappe.get_doc("Booking", _old_booking_name)
            _old_doc.status = "Cancelled"
            _old_doc.save(ignore_permissions=True)
            frappe.db.commit()
        # Jika booking lama bukan Pending (cth dah dibayar di tab lain),
        # biarkan sahaja — booking baharu akan dicipta, overbooking check
        # di bawah akan tangkap konflik jika ada.

    if is_b2b:
        # BIL KEPADA PARTNER — Customer pada SO/Booking ialah Customer
        # partner (entiti bil). End-customer tetap direkod sebagai
        # Customer sendiri (dari borang billing wizard) semata-mata
        # untuk akses portal traveller + linkage Contact, TANPA sebarang
        # dokumen kewangan atas namanya.
        customer_name = booking_actor["customer"]
        end_customer_name = existing_customer or _create_customer(billing)
        if end_customer_name == customer_name:
            # Partner guna email billing sendiri sebagai contact —
            # end_customer dikosongkan supaya tiada identiti berganda.
            end_customer_name = None
    else:
        customer_name = existing_customer or _create_customer(billing)
        end_customer_name = None

    # Alamat billing wajib (guard di atas) — disimpan sebagai Address
    # 'Billing' (primary) Customer supaya dokumen bil (SO/invois) ada
    # alamat lengkap. B2B: alamat wizard milik END CUSTOMER (bukan
    # partner — partner dibilkan atas alamat mereka sendiri); langkau
    # bila end_customer tiada rekod sendiri (partner guna email sendiri).
    _address_customer = end_customer_name if is_b2b else customer_name
    if _address_customer:
        _upsert_customer_billing_address(_address_customer, billing)

    # NOTA: _ensure_customer_company_currency() dihentikan penggunaannya —
    # model multi-company baharu tidak lagi memaksa Customer.default_currency
    # kepada satu company currency (customer boleh berurusan dengan company
    # berbeza ikut currency pakej yang ditempah). Customer.default_currency
    # dibiarkan sebagaimana ada.

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

    # Travel Price Rule (promosi price-slash): harga jualan berkesan =
    # harga promo. SO dibina atas harga NET (promo) — harga runcit asal
    # di-snapshot sebagai retail_total/price_rule_discount pada Booking
    # (selari model "SO net rate" yang dipilih untuk feature ni). B2B %
    # dan voucher/referral dikira ATAS harga promo (eff map).
    rule_ctx = resolve_ctx(trip_package, trip_group_date)
    eff_pricing_map, applied_price_info = apply_price_rules(pricing_map, rule_ctx)

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
    # TIDAK boleh melebihi max.
    #
    # SECURITY FIX (v2): Gunakan SELECT ... FOR UPDATE untuk lock row Trip Group Date
    # sebelum check — elak race condition (TOCTOU) di mana dua request serentak
    # membaca existing_pax yang sama, kedua-dua lulus check, dan overbooking berlaku.
    max_pax = int(td.max_participants or 0)
    if max_pax > 0:
        # Lock Trip Group Date row untuk serialise concurrent bookings
        frappe.db.sql("""
            SELECT name FROM `tabTrip Group Date`
            WHERE name = %s FOR UPDATE
        """, trip_group_date)

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

    # Room privacy — checkbox wizard untuk cabin cruise SOLO (total penghuni
    # main_guests + extra_beds + infants = 1 orang sahaja). "Open Sharing" =
    # customer minta padankan roommate; kosong/"Private" = tak minta. Mirror
    # guard frontend (renderRooms + payload). Whitelist + context check di
    # sini supaya payload client tak boleh suntik nilai luar jangka ke SO
    # Item (field custom_room_privacy).
    for s in selections:
        _privacy = (s.get("room_privacy") or "").strip()
        _pax = (int(s.get("main_guests", 0) or 0)
                + int(s.get("extra_beds", 0) or 0)
                + int(s.get("infants", 0) or 0))
        if is_cruise and _pax == 1 and _privacy in ("Private", "Open Sharing"):
            s["room_privacy"] = _privacy
        else:
            s["room_privacy"] = ""

    so_items    = _build_so_items(selections, eff_pricing_map, trip_name, td.trip_group_name, is_cruise)
    grand_total = sum(float(it["rate"]) * int(it["qty"]) for it in so_items)  # NET — harga promo

    # Harga runcit asal (sebelum price rule) — snapshot untuk komisen
    # affiliate/margin partner. Bila tiada rule berkesan, retail == net.
    retail_total = round(sum(
        _price_selection(
            pricing_map.get(s.get("room_category")),
            int(s.get("main_guests", 0) or 0),
            int(s.get("extra_beds", 0) or 0),
            int(s.get("infants", 0) or 0),
            is_cruise,
        )
        for s in selections
    ), 2)
    price_rule_discount = round(retail_total - grand_total, 2)
    # snapshot BEFORE any price-rule/voucher/referral discount — used for affiliate commission calc later
    pre_discount_total = retail_total

    # ── HARGA NET B2B (deducted price, BUKAN komisen) ────────────────────
    # Diskaun % partner atas harga runcit pakej (override per pakej >
    # default partner). Dilaksana sebagai ADDITIONAL DISCOUNT standard
    # ERPNext pada SO (apply_discount_on = "Grand Total", blok so_payload
    # di bawah) — BUKAN baris rate negatif, jadi tiada pergantungan pada
    # Selling Settings > Allow Negative Rates. pre_discount_total kekal
    # menyimpan harga runcit → margin partner = pre_discount_total − net.
    b2b_percent = 0
    if is_b2b:
        b2b_percent = _resolve_b2b_discount_percent(
            booking_actor["partner"], trip_package
        )

    # Voucher — hantar selections + trip_package supaya diskaun dikira ikut
    # scope (subtotal cabin yang match sahaja), bukan grand_total keseluruhan.
    #
    # MODEL BARU (PE deduction): SO kekal GROSS — diskaun TIDAK lagi
    # ditolak daripada grand_total dan TIADA baris item rate negatif.
    # Jumlah diskaun disimpan pada Booking (voucher_discount) dan
    # diserap sebagai deduction ke akaun Marketing Expenses pada Payment
    # Entry (corak sama dengan cashback Manual Transfer).
    voucher_discount = 0
    if voucher_code:
        vr = validate_voucher(voucher_code, trip_group_date, grand_total,
                              billing.get("email", ""), json.dumps(selections), trip_package, is_cruise)
        if vr.get("valid"):
            voucher_discount = float(vr.get("discount_amount", 0))

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
            # customer dapat extra discount.
            sales_partner     = ar.get("sales_partner")
            referral_percent  = float(ar.get("discount_percent", 0))
            # Tier B: % atas BAKI selepas voucher — sepadan dengan paparan
            # wizard (calcGrandTotal − voucher, kemudian % referral).
            referral_discount = round((grand_total - voucher_discount) * (referral_percent / 100), 2)

    # Manual Transfer cashback — KEKAL GROSS pada SO, dicatat sebagai
    # DEDUCTION dalam Payment Entry manual (debit ke akaun Marketing
    # Expenses company tersebut). Model lama (additional discount pada SO)
    # dibuang: dengan SO net, tiada gap untuk deduction menyerap dan
    # Payment Entry mesti tidak seimbang (ERPNext mewajibkan
    # received + deductions = allocated). Kelayakan cashback TIDAK lagi
    # di-snapshot ke Booking — ia TRANSAKSIONAL: dibaca semasa bayaran
    # daripada Booking.checkout_method (kaedah bayaran semasa checkout) +
    # Travel Settings semasa (rujuk so_helpers._get_booking_discount_snapshot()).
    # B2B: TIDAK layak cashback promo runcit — slot Additional Discount SO
    # digunakan untuk harga net partner (kontrak), bukan promosi.
    settings = frappe.get_cached_doc("Travel Settings")
    cashback_percent = 0
    if (payment_method == "Manual Transfer"
            and settings.manual_transfer_cashback_enabled and not is_b2b):
        cashback_percent = float(settings.manual_transfer_cashback_percent or 0)

    # Kaedah checkout untuk Booking — cermin pilihan bayaran wizard ni
    # (satu-satu penanda SALURAN bayaran pada booking; jadi sumber rujukan
    # kelayakan cashback Manual Transfer di semua pembaca Payment Entry).
    checkout_method = {
        "Online Payment":  "Online Payment Gateway",
        "Manual Transfer": "Manual Transfer",
        "Pay Later":       "Held Booking",
    }.get(payment_method, "")

    # Delivery Date = sehari SEBELUM tarikh berlepas — SO "kena complete"
    # (dari segi expected fulfilment ERPNext) sebelum trip bermula. Fallback
    # ke hari ini kalau departure_date somehow kosong (elak SO gagal insert).
    #
    # FIXED: Pastikan delivery_date tidak kurang dari hari ini (same-day booking)
    if td.departure_date:
        calculated_delivery = frappe.utils.add_days(td.departure_date, -1)
        # frappe.utils.today() returns string 'YYYY-MM-DD', convert to date for comparison
        today_str = frappe.utils.today()
        today_date = datetime_date(
            int(today_str[:4]), int(today_str[5:7]), int(today_str[8:10])
        )
        # Delivery date mesti >= hari ini (elak "before SO date" error ERPNext)
        delivery_date = max(calculated_delivery, today_date)
    else:
        delivery_date = frappe.utils.today()

    # Model multi-company: currency NATIVE pakej (dari DB — sumber
    # kebenaran, bukan payload) menentukan company yang mengeluarkan
    # SO/bil. SO tetap dalam company currency company berkenaan dengan
    # conversion_rate=1.0 — tiada conversion accounting. Kalau pakej
    # tiada currency (data lama), fallback company default.
    package_currency = frappe.db.get_value("Trip Package", trip_package, "currency")
    if not package_currency:
        package_currency = get_company_currency()
    so_currency, so_company, so_price_list, so_conversion_rate = \
        _resolve_so_currency_and_rate(package_currency)

    # Sales Order — insert & submit sebagai Administrator (elak isu permission
    # customer terhadap Link field dalaman seperti Account semasa validate SO).
    _original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        so_payload = {
            "doctype":            "Sales Order",
            "customer":           customer_name,
            "transaction_date":   frappe.utils.today(),
            "delivery_date":      delivery_date,
            "order_type":         "Sales",
            "items":              so_items,
            # Company yang mengeluarkan SO ditentukan oleh currency native
            # pakej (paksi currency multi-company). Price list per-currency
            # dari axis; rate item sentiasa di-set eksplisit dari Trip
            # Package Price, jadi price list di sini mekanikal.
            "company":            so_company,
            "selling_price_list": so_price_list,
            "currency":           so_currency,
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
            # DISKAUN ORDER-LEVEL (model PE deduction) — SO kekal GROSS;
            # jumlah diskaun voucher/referral disimpan pada Booking (bukan
            # SO) sebagai sumber rujukan pencipta Payment Entry
            # (wizard/portal/Stripe) untuk menyerapnya sebagai deduction ke
            # akaun Marketing Expenses. Rujuk _build_discount_deduction_rows().
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
            # CASHBACK — SO kekal GROSS (tiada additional discount). Kelayakan
            # dicatat pada Booking.checkout_method ("Manual Transfer") untuk
            # deduction per-Payment Entry (wizard + bayaran baki manual
            # portal). Akaun Marketing Expenses company mesti sedia ada —
            # kalau tidak, cashback dipromosi ke customer tapi tak boleh
            # dicatat dalam akaun: gagalkan awal SEBELUM SO/booking dicipta
            # (config error yang jelas).
            if not _resolve_cashback_discount_account(so_company, so_currency):
                frappe.throw(
                    "Cashback Discount Account (Marketing Expenses) is not configured "
                    "for company '{0}' / currency '{1}' in Travel Settings. "
                    "Configure it in Travel Settings > Multi Currency Account "
                    "(or the global fallback) before enabling Manual Transfer cashback.".format(
                        so_company or "-", so_currency or "-")
                )
        elif b2b_percent > 0:
            # HARGA NET B2B — diskaun standard ERPNext atas Grand Total.
            # Tiada baris rate negatif & tiada akaun diwajibkan; potongan
            # mengurangkan pendapatan semula jadi (admin boleh set
            # additional_discount_account di Desk kemudian jika mahu
            # posting berasingan). Deposit/bayaran dikira dari grand_total
            # net SO selepas ini (rujuk grand_total = so.grand_total).
            so_payload.update({
                "apply_discount_on":              "Grand Total",
                "additional_discount_percentage": b2b_percent,
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
        frappe.local.session.user = _original_user

    # Guna grand_total SEBENAR dari SO (selepas additional discount, jika ada)
    # supaya deposit/full-payment dikira dari jumlah yang betul-betul perlu
    # dibayar. "Disable Rounded Total" kini global (Selling Settings) — SO
    # ni (dan semua SO lain dalam app) tak lagi ada rounded_total berlainan
    # dari grand_total, jadi guna grand_total terus tanpa fallback.
    grand_total = float(so.grand_total or 0)

    # NET PAYABLE — gross SO ditolak diskaun order-level (voucher/referral)
    # yang kini diserap sebagai PE deduction, BUKAN ditolak pada SO (SO
    # kekal GROSS). Semua pengiraan jumlah BAYARAN customer (deposit/full/
    # cashback base) kekal atas nilai NET ini — sama math yang customer
    # nampak di wizard.
    net_total = round(grand_total - voucher_discount - referral_discount, 2)

    # ══════════════════════════════════════════════
    # SECURITY FIX (v2): Deposit calc server-side sahaja
    # amount_paid dari client DIABAIKAN — compute deposit dari settings
    # ══════════════════════════════════════════════
    default_deposit_percent = float(settings.default_deposit_percent or 20)
    std_deposit    = round(net_total * (default_deposit_percent / 100), 2)
    online_min = float(getattr(settings, "online_payment_min_amount", 0) or 0)

    # Online Payment mustahil bila jumlah penuh trip sendiri < min gateway
    # (mustahil caj Stripe mencukupi walau bayar full) — reject awal, elak
    # booking dicipta dengan kaedah yang tak boleh dibayar.
    if payment_method == "Online Payment" and online_min and net_total < online_min:
        frappe.throw(
            _("Online payment requires a minimum total of {0}. Please choose Manual Transfer or Held Booking.").format(
                frappe.utils.fmt_currency(online_min, currency=so.currency or "MYR")
            ),
            title="Below Online Payment Minimum"
        )

    # Ignore client-supplied amount_paid — compute server-side based on payment_type
    if payment_type == "Deposit":
        deposit_amount = std_deposit
        # Online Payment: Stripe ada min charge per currency — bila deposit
        # biasa lebih rendah dari min gateway, angkat deposit ke min gateway
        # (di-cap pada net payable) supaya caj Stripe mencukupi dan guard di
        # create_payment_intent tak reject. Deposit biasa sentiasa menjadi
        # asas (tak pernah kurang dari std_deposit).
        if payment_method == "Online Payment" and online_min and deposit_amount < online_min:
            deposit_amount = min(online_min, net_total)
    else:
        deposit_amount = net_total  # Full Payment

    # Validate: deposit mesti antara min_deposit dan net payable
    if deposit_amount < std_deposit and abs(deposit_amount - net_total) > 0.01:
        frappe.throw(
            _("Minimum deposit is {0}% ({1}) of total ({2}).").format(
                default_deposit_percent,
                frappe.utils.fmt_currency(std_deposit),
                frappe.utils.fmt_currency(net_total)
            ),
            title="Invalid Payment Amount"
        )

    # CASHBACK Manual Transfer — deposit_amount ialah bahagian NET yang
    # dibetulkan (sebelum diskaun order-level & cashback diangkat ke GROSS
    # dalam PE). Cash sebenar yang customer transfer = net DITOLAK cashback;
    # bahagian cashback + diskaun voucher/referral masuk Payment Entry
    # sebagai DEDUCTION ke akaun Marketing Expenses company (received +
    # deductions = allocated → PE seimbang).
    cashback_pe_amount = 0
    if cashback_percent > 0:
        cashback_pe_amount = round(deposit_amount * (cashback_percent / 100), 2)
    cash_due = round(deposit_amount - cashback_pe_amount, 2)
    # Bahagian GROSS SO untuk allocation PE manual = net deposit DITAMBAH
    # semula diskaun order-level yang diserap pada PE ni (di-cap ke gross SO
    # — kes edge: diskaun melebihi net deposit).
    gross_allocated_pe = round(min(
        grand_total,
        deposit_amount + voucher_discount + referral_discount,
    ), 2)

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
        # Company pengeluar SO utama (dari paksi currency — currency native
        # pakej menentukan company). Snapshot untuk filter/reporting; SO
        # tetap sumber kebenaran accounting.
        "company":        so_company,
        # PENTING: attribution affiliate (untuk commission) TAK bergantung
        # pada referral_discount > 0 — sales_partner dah sah (atau None)
        # ditentukan di atas terus dari validate_affiliate_code(), jadi
        # guna terus di sini tanpa syarat tambahan.
        "affiliate":            sales_partner,
        "pre_discount_total":   pre_discount_total,
        # SNAPSHOT promosi Travel Price Rule (price slash) — jumlah jimat
        # (retail − net) + senarai rule yang menang. SO sendiri dibina atas
        # harga promo (net), jadi diskaun ini TIDAK diserap sebagai Payment
        # Entry deduction (beza daripada voucher/referral di bawah).
        "price_rule_discount":  round(price_rule_discount or 0, 2),
        "applied_price_rules":  _price_rules_json(applied_price_info, rule_ctx),
        # SNAPSHOT diskaun order-level — sumber kebenaran untuk semua
        # pencipta Payment Entry (wizard manual, portal, Stripe settlement)
        # menyerap diskaun sebagai deduction ke akaun Marketing Expenses,
        # sementara SO kekal GROSS (rujuk so_helpers.
        # _get_booking_discount_snapshot()). Nilai dah dikira di awal —
        # sebelum SO wujud — jadi selamat ditulis terus di sini. Kelayakan
        # cashback pula TIDAK di-snapshot di sini — ia dibaca semasa
        # bayaran daripada checkout_method + Travel Settings semasa
        # (benefit transaksional, rujuk _get_booking_discount_snapshot()).
        "voucher_discount":     round(voucher_discount or 0, 2),
        "referral_discount":    round(referral_discount or 0, 2),
        # Kaedah bayaran semasa checkout — di-set SEKALI (set_only_once)
        # dan menentukan kelayakan cashback Manual Transfer semasa
        # bayaran baki dibuat kemudian.
        "checkout_method":      checkout_method,
        # SNAPSHOT email & phone pada masa booking dicipta — SENGAJA bukan
        # field virtual/live (beza dari property get_cust_phone yang
        # live-compute dari Contact). Nilai diambil TERUS dari borang
        # billing wizard (phone di-validate frontend sebelum step 3, jadi
        # sentiasa ada) — salinan sejarah/audit trail masa booking dibuat,
        # bukan rujukan "terkini" kalau customer kemudian tukar Contact.
        "cust_email":           email,
        "get_cust_booking_phone": standardize_phone_to_hyphen(billing.get("phone")),
        # SNAPSHOT alamat billing (street/city/postcode/state/country) —
        # salinan sejarah masa booking dicipta, corak sama dengan cust_email
        # di atas: booking tidak berubah bila admin/edit alamat Customer
        # kemudian. Nilai sudah di-trim & divalidate wajib di awal fungsi.
        # Alamat operasional (invois/SO) kekal pada doctype Address yang
        # di-link ke Customer (rujuk _upsert_customer_billing_address()).
        "cust_address_line1":   billing.get("address_line1"),
        "cust_city":            billing.get("city"),
        "cust_postcode":        billing.get("postcode"),
        "cust_state":           billing.get("state"),
        "cust_country":         billing.get("country"),
        # SNAPSHOT jumlah yang perlu dibayar SEMASA booking dicipta — nilai
        # yang sama dipulangkan wizard ("amount_due"): deposit (atau full
        # payment, atau cash selepas cashback untuk Manual Transfer).
        # Property virtual Booking tak boleh derive nilai ni (payment_type
        # Deposit/Full tidak disimpan pada Booking), jadi ia disimpan sebagai
        # salinan sejarah masa checkout (corak sama cust_email/
        # pre_discount_total) — dipapar notifikasi Telegram "NEW TRIP
        # BOOKING" & memudahkan rujukan Desk/laporan.
        "payment_due_amount":   round(cash_due or 0, 2),
        # Modul booking-channel (fasa 1): rekod SIAPA/SALURAN mana booking
        # ni dibuat. booking_channel "Direct" untuk customer sendiri;
        # "Staff"/"Affiliate" bila checkbox on-behalf aktif DAN session
        # user mempunyai role yang layak (booking_actor di atas). booked_by
        # sentiasa merakam session user ter-authenticate (audit trail),
        # kosong untuk Guest.
        "booking_channel":      (booking_actor["channel"] if booking_actor else "Direct"),
        "booked_by":            session_user,
        # SALURAN B2B: partner yang dibilkan + end-customer pemilik akses
        # portal. Kosong (None) untuk saluran Direct/Staff/Affiliate —
        # behavior lama tidak berubah.
        "b2b_partner":          (booking_actor["partner"] if is_b2b else None),
        "end_customer":         end_customer_name,
        # ── T&C + pesanan customer (snapshot persetujuan masa checkout) ──
        # Nilai telah disahkan melalui gate di atas: bila dokumen dipilih di
        # Travel Website (per-vertikal), terms_accepted WAJIB true dan
        # terms_reference WAJIB padan dokumen tu — jadi rekod di bawah
        # sentiasa konsisten. Link ke DOKUMEN T&C (bukan salinan teks)
        # supaya audit boleh rujuk dokumen tepat yang dipaparkan semasa
        # customer tick; lihat disiplin versi di Travel Website →
        # section "Booking Terms & Conditions".
        "terms_accepted":       1 if (active_terms and terms_accepted) else 0,
        "terms_reference":      (active_terms.name if (active_terms and terms_accepted) else None),
        "terms_accepted_at":    (frappe.utils.now_datetime() if (active_terms and terms_accepted) else None),
        "customer_message":     (customer_message or None),
    })
    booking.insert(ignore_permissions=True)

    # SO utama dikaitkan SEMATA-MATA melalui Sales Order.custom_booking (one-
    # standard: SO rujuk Booking, bukan dua-hala). SO dicipta SEBELUM Booking
    # wujud, jadi baru boleh diisi sekarang selepas booking.name ada.
    # PENTING: link ini MESTI ditulis SEBELUM _ensure_portal_user() di bawah —
    # fungsi tu frappe.db.commit() (cipta User baru), jadi jika langkah lewat
    # gagal & rollback (cth Payment Entry), booking yang dah ter-commit kerana
    # commit separa tu akan kekal TANPA link custom_booking (booking yatim,
    # order_summary/total_amount jadi kosong). Dengan urutan ni, link tersimpan
    # dalam commit separa yang sama.
    frappe.db.set_value("Sales Order", so.name, "custom_booking", booking.name)

    # Portal access — cipta User serentak dengan Booking (bukan lazy-created
    # bila customer minta login link). Kalau email ni dah ada User (returning
    # customer), tak buat apa-apa — reuse User sedia ada. B2B: User portal
    # diambil dari nama END CUSTOMER (bukan partner — partner tiada akaun
    # portal traveller; mereka guna akaun sendiri yang dikonfigur dalam
    # Travel B2B Partner User).
    is_new_user = _ensure_portal_user(email, end_customer_name or customer_name)
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
    payment_error = None
    if payment_method == "Online Payment":
        # Caj Stripe atas NET payable (SO gross, diskaun diserap kemudian
        # oleh _create_discount_settlement_entry() lewat webhook).
        pay_amount = deposit_amount if payment_type == "Deposit" else net_total
        payment_url, payment_error = _create_payment_url(
            customer_name = customer_name,
            so_name       = so.name,
            amount        = pay_amount,
            booking_number = booking.booking_number,
        )
    elif payment_method == "Manual Transfer" and receipt and cash_due > 0:
        # PE manual: cash = net deposit tolak cashback; bahagian GROSS SO
        # yang diallocate = cash + cashback + diskaun order-level — beza tu
        # masuk sebagai baris deduction ke akaun Marketing Expenses.
        # cash_due <= 0 (diskaun meliputi keseluruhan deposit): tiada cash
        # untuk ditransfer — PE dig_SKIP; diskaun kekal untuk diserap pada
        # bayaran seterusnya melalui portal.
        _create_manual_payment_entry(
            so_name       = so.name,
            customer_name = customer_name,
            amount        = cash_due,
            receipt_data  = receipt,
            label         = "receipt-" + booking.booking_number,
            bank_transfer_ref = bank_transfer_ref,
            payment_date  = bank_transfer_date,
            note          = bank_transfer_note,
            cashback_percent  = cashback_percent,
            allocated_amount  = gross_allocated_pe,
            discount_components = [
                ("Voucher " + voucher_code, voucher_discount),
                ("Referral " + (affiliate_code or ""), referral_discount),
            ] if (voucher_discount > 0 or referral_discount > 0) else None,
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

    # Telegram "NEW TRIP BOOKING" — trigger EKSPLISIT di sini, BUKAN event
    # after_insert standard. Punca: SO utama dicipta DAHULU tanpa link
    # (booking.name belum wujud masa tu), dan `Sales Order.custom_booking`
    # hanya ditulis SELEPAS booking.insert() selesai — jadi hook
    # after_insert (yang berlaku DALAM insert()) terbakar ketika
    # order_summary/total_amount (property yang resolve SO melalui
    # custom_booking) masih kosong/0, dan notifikasi terhantar data tak
    # lengkap. Notifikasi dikonfigur dengan event Method =
    # "booking_created" supaya hook standard tak fire; ia hanya fire di
    # sini — selepas custom_booking ditulis & SEMUA transaksi committed
    # (stripe URL / PE manual / voucher), jadi booking yang gagal di
    # langkah lewat tak sempat diumumkan.
    try:
        from erpnext_telegram_integration.erpnext_telegram_integration.doctype.telegram_notification.telegram_notification import (
            run_telegram_notifications,
        )
        run_telegram_notifications(
            frappe.get_doc("Booking", booking.name), "booking_created"
        )
    except Exception:
        # Notifikasi TIDAK boleh gagalkan booking yang dah berjaya — log
        # sahaja untuk semakan admin.
        frappe.log_error(
            frappe.get_traceback(), "Telegram NEW TRIP BOOKING trigger failed"
        )

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
        "net_total":      net_total,
        "amount_due":     cash_due,
        "reservations_created": res_created,
        "booking_status": booking.status,
        "payment_status": _compute_payment_status(0, grand_total),
        "advance_paid":   0,
        "payment_type":   payment_type,
        "payment_method": payment_method,
        "payment_url":    payment_url,
        "payment_setup_failed": bool(payment_error),
        "payment_error":  payment_error,
        "cashback_percent": cashback_percent,
        "cashback_amount":  round(net_total * (cashback_percent / 100), 2) if cashback_percent > 0 else 0,
        "voucher_discount":  round(voucher_discount, 2),
        "referral_discount": round(referral_discount, 2),
    }


# ══════════════════════════════════════════════
# STATUS ENGINE
# ══════════════════════════════════════════════

# Status bayaran refund — dikekalkan walaupun booking Cancelled/Abandoned
# (cermin Booking.REFUND_PAYMENT_STATES doctype controller).
_REFUND_PAYMENT_STATES = ("Request Refund", "Pending Refund", "Refunded")


def _recompute_booking_status(so_name, exclude_current=False, fire_flows=True):
    """Kira semula field STORED booking (payment_status, prog_payment,
    pre_discount_total, booked_pax) dari GABUNGAN SEMUA SO yang berkaitan
    booking (SO utama + SO addon seperti excursion/servis tambahan yang admin
    create berasingan, dikaitkan melalui Sales Order.custom_booking).

    Dipanggil dari hook Payment Entry (submit/cancel) DAN hook Sales Order
    (on_update/on_update_after_submit/on_cancel/on_trash — rujuk
    on_sales_order_change()) supaya snapshot booking sentiasa selari dengan
    SO — walaupun admin edit SO terus di Desk selepas booking dicipta
    (ubah pax/rate, tambah item, cancel, dsb).

    Semantik pre_discount_total (live-sync): jumlah GROSS semua SO —
    grand_total + additional discount SO (harga runcit sebelum diskaun
    B2B yang dibawa pada SO itu sendiri). Diskaun voucher/referral TIDAK
    ditolak di sini kerana model baharu SO kekal GROSS (diskaun diserap
    sebagai PE deduction) — jadi untuk booking runcit biasa
    pre_discount_total == jumlah grand_total (sama dengan total_amount);
    hanya B2B yang berbeza (grand_total = net). Ini kekal makna asal
    snapshot (harga runcit → margin partner = pre_discount_total − net)
    tetapi tak lagi stale bila SO diedit.

    PENTING (flow status baharu):
    - "Pending" -> "Accepted": auto, sebaik bayaran PERTAMA masuk (Partially
      Paid atau Paid) — booking baru mula sebagai "Pending" (belum bayar).
    - "Accepted" -> "Processing"/"Confirmed": TIDAK berlaku di sini —
      peralihan ni kini MANUAL sepenuhnya (admin pilih terus value baharu
      di field status Booking di Desk; rujuk on_booking_update()).
    - "Cancelled" tetap sticky (status di-skip, tapi payment_status tetap
      dikemaskini supaya rekod bayaran refund/partial kekal tepat).

    'exclude_current': set True bila dipanggil dari event on_cancel/on_trash
    SO — semasa event tu berjalan, row SO dalam DB masih berdocstatus 1
    (on_cancel) atau masih wujud (on_trash), jadi _get_all_booking_sales_orders()
    masih akan memasukkannya; buang secara eksplisit supaya agregat tak
    mengira SO yang sedang dibatalkan/dipadam.

    'fire_flows': False = KIRA & TULIS field snapshot SAHAJA — skip semua
    aliran sampingan (email status, activation reservation, auto-invoice,
    refresh Booking Addon, activation share traveller). Untuk patch
    migration/skrip resync bulk supaya data betul TANPA hantar email ke
    customer atau cipta dokumen perakaunan secara senyap. Default True
    (behavior hook runtime).
    """
    booking_name = _resolve_booking_from_so(so_name)
    if not booking_name:
        return

    all_so_names = _get_all_booking_sales_orders(booking_name)
    if exclude_current and so_name in all_so_names:
        all_so_names = [n for n in all_so_names if n != so_name]
    if not all_so_names:
        if exclude_current:
            # Semua SO booking dah dibatalkan/dipadam — kosongkan snapshot
            # supaya booking tak kekal baki/total/pax palsu. (Tiada SO untuk
            # activation/auto-invoice — berhenti di sini.) Payment status
            # ikut syarat 4 — 'Canceled' bila booking Cancelled/Abandoned.
            _st = frappe.db.get_value("Booking", booking_name, "status")
            frappe.db.set_value("Booking", booking_name, {
                "pre_discount_total": 0,
                "prog_payment": 0,
                "payment_status": "Canceled" if _st in ("Cancelled", "Abandoned")
                    else "Pending",
                "booked_pax": 0,
            })
        return

    # NOTA: "Disable Rounded Total" kini global (Selling Settings) — semua
    # SO berkaitan booking tak lagi ada rounded_total berlainan dari
    # grand_total, jadi standardize ke grand_total sahaja.
    total = 0
    paid  = 0
    gross = 0
    for name in all_so_names:
        so = frappe.db.get_value(
            "Sales Order", name,
            ["grand_total", "advance_paid", "apply_discount_on", "discount_amount"],
            as_dict=True)
        if so:
            grand = float(so.grand_total or 0)
            total += grand
            paid  += so.advance_paid or 0
            # Additional discount standard ERPNext pada SO (laluan B2B /
            # edit admin) — kembalikan untuk dapat harga gross runcit.
            if so.apply_discount_on and float(so.discount_amount or 0):
                grand += float(so.discount_amount)
            gross += grand

    new_payment_status = _compute_payment_status(paid, total)

    # Syarat 4 — booking Cancelled/Abandoned → payment_status 'Canceled'
    # (kecuali aliran refund sedang berjalan — Request Refund/Pending
    # Refund/Refunded dikekalkan kerana maklumat refund lebih spesifik).
    # Syarat 1-3 di atas kekal dikira supaya rekod bayaran kekal tepat.
    booking_status, cur_pay_status = frappe.db.get_value(
        "Booking", booking_name, ["status", "payment_status"]) or (None, None)
    if booking_status in ("Cancelled", "Abandoned") and (
            cur_pay_status or "Pending") not in _REFUND_PAYMENT_STATES:
        new_payment_status = "Canceled"

    # pre_discount_total di-sync di sini (bukan dikira on-the-fly) kerana
    # field STORED — dipakai laporan & kiraan komisen affiliate. Tanpa sync
    # ni, snapshot masa booking dicipta kekal stale bila SO diedit (punca
    # paparan Booking vs Sales Order tak sepadan).
    b = frappe.db.get_value(
        "Booking", booking_name,
        ["name", "status", "payment_status", "prog_payment", "pre_discount_total",
         "booked_pax"],
        as_dict=True)
    if not b:
        return

    if float(b.pre_discount_total or 0) != round(gross, 2):
        frappe.db.set_value("Booking", b.name, "pre_discount_total", round(gross, 2))

    # booked_pax — jumlah pax SEBENAR booking ni: SUM qty baris TRAVEL-PKG
    # pada SEMUA SO aktif (baris addon TRAVEL-ADDON/TRAVEL-INSURANCE tidak
    # terlibat). Sama corak pre_discount_total: field STORED yang menjadi
    # sumber gate overbooking (SUM(booked_pax) per trip date) & seat count
    # trip catalog — tanpa sync ni, edit pax pada SO (draft mahupun
    # update-after-submit) meninggalkan booked_pax stale sedangkan
    # order_summary (virtual, kira live dari SO) terus betul.
    so_pax = int(round(frappe.db.sql("""
        SELECT COALESCE(SUM(soi.qty), 0)
        FROM `tabSales Order Item` soi
        WHERE soi.parent IN %s AND soi.item_code = %s
    """, (tuple(all_so_names), TRAVEL_ITEM_CODE))[0][0] or 0))
    if int(b.booked_pax or 0) != so_pax:
        frappe.db.set_value("Booking", b.name, "booked_pax", so_pax)

    # prog_payment: peratusan kemajuan bayaran, formula (1 - (balance/total))
    # * 100 — field STORED sebenar (bukan @property macam total_amount/
    # balance_amount), jadi WAJIB ditulis eksplisit di sini setiap kali
    # payment data SO berkaitan berubah (bukan dikira on-the-fly semasa
    # baca), supaya sentiasa terkini untuk paparan List View/laporan.
    balance = max(0, total - paid)
    new_prog_payment = round((1 - (balance / total)) * 100) if total > 0 else 0

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
        if fire_flows:
            _send_status_email(b.name, "Accepted")

    # Reservation dicipta sebaik payment_status mula ada sebarang bayaran —
    # TIDAK bergantung pada status booking (Processing/Confirmed kini
    # ditetapkan admin secara manual, bukan auto dari sini).
    #
    # PENTING: _activate_booking dipanggil dari hook on_payment_entry_submit
    # (semasa Payment Entry submit). Jika ia throw (cth room_category lapuk,
    # rujuk _activate_booking), exception akan mengroll-back seluruh submit
    # Payment Entry → bayaran customer tak direkodkan walhal Stripe dah berjaya.
    # Tangkap exception di sini supaya bayaran SENTIASA direkodkan; reservation
    # boleh dicipta/dibaiki admin kemudian (rujuk Error Log).
    if fire_flows and new_payment_status in ("Partially Paid", "Paid") and not had_any_payment:
        try:
            _activate_booking(b.name)
        except Exception as e:
            frappe.log_error(
                title="Booking Activation Error",
                message="_activate_booking gagal untuk " + str(b.name) + " (SO " +
                str(so_name) + "): " + str(e) + ". Bayaran tetap direkodkan; "
                "reservation perlu dibuat/dibaiki manual.",
            )

    if not fire_flows:
        # Patch/skrip resync — snapshot dah ditulis, berhenti di sini
        # (tiada email/invois/dokumen sampingan).
        return

   # Auto-invoice — SENGAJA berasingan dari new_payment_status di atas.
    # new_payment_status tu peringkat BOOKING (agregat SEMUA SO berkaitan
    # booking — utama + addon). Auto-invoice pula per-SO INDEPENDENT (satu
    # SO addon settle tak tunggu SO utama settle juga, atau sebaliknya) —
    # jadi perlu check terus status bayaran SO ni SENDIRI, bukan agregat.
    _maybe_auto_invoice_so(so_name)

    # Booking Addon — kalau SO ni ialah SO addon (bukan SO cabin
    # utama), refresh payment_status/status order tu SENDIRI (per-SO,
    # BUKAN agregat booking — rujuk nota reka bentuk addon/insurance:
    # order addon yang dah fully paid tak patut nampak "belum paid" sebab
    # baki SO cabin lain belum settle). Guard frappe.db.exists() elak
    # error kalau addon feature belum di-deploy (doctype belum wujud lagi
    # semasa migration progresif).
    if frappe.db.exists("DocType", "Booking Addon"):
        addon_order_name = frappe.db.get_value("Booking Addon", {"sales_order": so_name}, "name")
        if addon_order_name:
            frappe.get_doc("Booking Addon", addon_order_name).refresh_payment_status()

    # Room sharing — traveller tambahan (rujuk api/cabin_sharing.py):
    # bila SO traveller tambahan (SO bukan primary booking + item
    # TRAVEL-PKG, dipaut melalui custom_booking sahaja) dibayar PENUH,
    # cipta slot Booking Reservation dalam cabin sasaran. Bukan SO
    # traveller tambahan → no-op. Exception ditangkap supaya Payment
    # Entry tetap direkodkan (corak sama dengan _activate_booking di atas).
    try:
        _activate_share_traveller_reservation(so_name)
    except Exception as e:
        frappe.log_error(
            title="Share Traveller Activation Error",
            message="Share traveller activation gagal untuk SO " + str(so_name) +
            ": " + str(e) + ". Bayaran tetap direkodkan; slot reservation "
            "perlu dibuat/dibaiki manual.")


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

    Payment Request Stripe juga di-cancel untuk setiap SO — tanpa ni,
    PR "Requested" yang ditinggalkan customer (Back dari checkout) kekal
    aktif dan boleh menghalang PR baharu untuk SO yang sama (ERPNext
    validate_payment_request_amount mengumpul SEMUA PR submitted).
    """
    for r in frappe.get_all("Booking Reservation",
                            filters={"booking": booking_doc.name, "status": ["!=", "Cancelled"]},
                            fields=["name"]):
        res = frappe.get_doc("Booking Reservation", r.name)
        # Cancelled ditetapkan EKSPLISIT (bukan compute) — status Booking
        # dalam save ni belum commit; pengiraan auto baca DB boleh tengok
        # nilai lama. apply_auto_status dalam validate() menghormatinya:
        # reservation Cancelled ialah terminal (rujuk guard terminal
        # compute_auto_status), rule #1 pun mengesahkan nilai yang sama.
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
            # Cancel Payment Request Stripe untuk SO ni dahulu —
            # PR yang masih aktif menghalang pembatalan SO di ERPNext
            # (atau meninggalkan PR yatim yang mengganggu PR baharu).
            _cancel_payment_requests_for_so(so_name)
            try:
                so_doc = frappe.get_doc("Sales Order", so_name)
                so_doc.flags.ignore_permissions = True
                so_doc.cancel()
            except Exception as e:
                frappe.log_error(title="Booking Cancel", message="Cancel SO failed " + so_name + ": " + str(e))
        elif (so.advance_paid or 0) > 0:
            frappe.log_error(
                title="Booking Cancel - Refund Needed",
                message="Booking " + booking_doc.name + " cancelled but SO " + so_name +
                " has payment RM" + str(so.advance_paid) + ". Refund & cancel SO requires manual action.")

    if total_paid > 0:
        frappe.db.set_value("Booking", booking_doc.name, "payment_status", "Request Refund")


def _cancel_payment_requests_for_so(so_name: str) -> None:
    """Cancel semua Payment Request (docstatus=1, belum Paid) untuk satu SO.

    Dipanggil oleh _cancel_booking_cascade sebelum SO di-cancel — PR Stripe
    yang ditinggalkan customer (Back dari checkout) perlu dibersihkan
    supaya: (a) tidak menghalang pembatalan SO, dan (b) tidak mengumpul
    jumlah yang menyebabkan validate_payment_request_amount() throw
    untuk PR baharu pada SO yang sama.
    """
    old_prs = frappe.get_all(
        "Payment Request",
        filters={
            "reference_doctype": "Sales Order",
            "reference_name":    so_name,
            "docstatus":         1,
            "status":            ["not in", ["Paid", "Cancelled"]],
        },
        pluck="name",
    )
    for pr_name in old_prs:
        try:
            pr = frappe.get_doc("Payment Request", pr_name)
            pr.flags.ignore_permissions = True
            pr.cancel()
        except Exception as e:
            frappe.log_error(
                title="Booking Cancel - PR Cleanup Error",
                message="Failed to cancel Payment Request " + pr_name + " for " + so_name + ": " + str(e),
            )


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


def on_sales_order_change(doc, method=None):
    """Hook: Sales Order on_update / on_update_after_submit / on_cancel /
    on_trash (rujuk hooks.py doc_events) — pastikan Booking yang dipaut
    melalui Sales Order.custom_booking SENTIASA selari dengan SO bila
    admin edit terus di Desk: ubah pax/rate item, tambah/kurang item,
    apply diskaun tambahan, cancel atau padam SO.

    Tanpa hook ni, field snapshot booking (pre_discount_total, dan
    payment_status/prog_payment bila total berubah) hanya dikira SEKALI
    semasa booking dicipta — paparan Booking jadi tak sepadan dengan SO
    selepas edit (kes sebenar: booking RIUQRXL2610 — SO dikurangkan 2 pax
    → 1 pax tapi Pre-Discount Total kekal harga lama).

    SO tanpa custom_booking (SO biasa bukan booking travel) → balik awal,
    kosong sifar. Pada on_cancel/on_trash, SO disingkirkan secara eksplisit
    daripada agregat (row masih docstatus 1 / masih wujud semasa event
    berjalan — rujuk _recompute_booking_status exclude_current).
    """
    if not getattr(doc, "custom_booking", None):
        return
    _recompute_booking_status(
        doc.name,
        exclude_current=(method in ("on_cancel", "on_trash")),
    )


@frappe.whitelist()
def sync_booking_payment_status(booking: str):
    """API umum — kira semula payment_status SATU booking (guna semula
    enjin _recompute_booking_status: Pending / Partially Paid / Paid dari
    agregat semua SO booking) dan terapkan syarat 4 — 'Canceled' bila
    status booking Cancelled/Abandoned (kecuali aliran refund berjalan).
    Untuk webhook pembayaran, integrasi luar, penyelarasan manual, atau
    aliran lain yang perlukan peraturan payment status yang sama. Akses
    disegerakkan dengan page Manage Booking (peranan pengurusan).
    Return {booking, status, payment_status}.
    """
    from travel_booking.api.manage_trip_booking import _require_access
    _require_access()
    if not booking or not frappe.db.exists("Booking", booking):
        frappe.throw(_("Booking {0} not found").format(booking))
    so_names = _get_all_booking_sales_orders(booking)
    if so_names:
        _recompute_booking_status(so_names[0])
    status, ps = frappe.db.get_value(
        "Booking", booking, ["status", "payment_status"]) or (None, None)
    if status in ("Cancelled", "Abandoned") and (
            ps or "Pending") not in _REFUND_PAYMENT_STATES:
        frappe.db.set_value("Booking", booking, "payment_status", "Canceled")
        ps = "Canceled"
    return {"booking": booking, "status": status, "payment_status": ps}


def on_booking_update(doc, method=None):
    """Hook: Booking.on_update — kesan peralihan status yang dibuat MANUAL
    oleh admin di Desk (pilih value baharu terus di field 'status'), dan
    hantar email sepadan. Turut kesan peralihan ke 'Cancelled' untuk
    jalankan cascade dan ke 'Completed' untuk sebar status ke reservation.

    PENTING: "Pending" -> "Accepted" TIDAK dikesan di sini — peralihan tu
    automatik ikut bayaran (rujuk _recompute_booking_status(), dipanggil
    dari hook Payment Entry). "Completed" auto ikut tarikh trip (rujuk
    mark_completed_trips()) juga TIDAK lalui sini — scheduler itu sync
    reservation sendiri; cabang Completed di bawah liput peralihan MANUAL
    sahaja (Desk / Booking Hub update_booking_status).
    """
    old = doc.get_doc_before_save()
    if not old or old.status == doc.status:
        return  # tiada perubahan status — tak perlu buat apa-apa

    if doc.status == "Cancelled":
        _cancel_booking_cascade(doc)
    elif doc.status == "Completed":
        # Sebar ke reservation (Booking Completed → reservation Completed;
        # reservation terminal tak diketuk ke belakang — rujuk
        # sync_status_for_booking).
        from travel_booking.module_travel_booking.doctype.booking_reservation.booking_reservation import (
            sync_status_for_booking,
        )
        sync_status_for_booking(doc.name)
    elif doc.status == "Processing" and old.status != "Processing":
        _send_status_email(doc.name, "Processing")
    elif doc.status == "Confirmed" and old.status != "Confirmed":
        _send_status_email(doc.name, "Confirmed")


# ══════════════════════════════════════════════
# SCHEDULED TASK
# ══════════════════════════════════════════════

def mark_completed_trips(booking_name=None):
    """Scheduled task (harian, rujuk hooks.py scheduler_events) — auto-tukar
    status booking "lapuk" ke 'Completed'. Booking lapuk = tarikh hari ini
    sudah melepasi return_date trip (bukan departure — cruise masih berjalan
    sehingga return date). Booking yang layak: Confirmed, Processing DAN
    Accepted — peralihan ke Processing/Confirmed kini manual (admin pilih
    di Desk), jadi tanpa status-status ni booking yang tak sempat
    di-confirm sebelum trip berlalu kekal lapuk selama-lamanya (kes
    sebenar: BK2609009/16/22 — trip RTRC2602/2604 kembali 10 Okt tapi
    kekal 'Processing' sampai admin complete manual 15 Okt). 'Pending'
    dikecualikan (belum pernah bayar/aktif — calon 'Abandoned', bukan
    'Completed'). return_date diambil dari Trip Group Date, fallback ke
    field return_date Booking sendiri. booking_name (opsyenal) untuk
    test/panggil manual terhadap satu booking sahaja.
    """
    today = frappe.utils.today()
    params = {"today": today}
    extra_filter = ""
    if booking_name:
        extra_filter = "AND b.name = %(booking_name)s"
        params["booking_name"] = booking_name

    # Gunakan frappe.get_all untuk consistency dan keselamatan SQL
    bookings = frappe.db.sql("""
        SELECT b.name
        FROM `tabBooking` b
        INNER JOIN `tabTrip Group Date` td ON td.name = b.trip_date
        WHERE b.status IN ('Confirmed', 'Processing', 'Accepted')
          AND COALESCE(td.return_date, b.return_date) IS NOT NULL
          AND DATE(COALESCE(td.return_date, b.return_date)) < DATE(%(today)s)
          {extra}
    """.format(extra=extra_filter), params, as_dict=True)

    count_completed = 0
    for b in bookings:
        try:
            frappe.db.set_value("Booking", b.name, "status", "Completed")
            _send_status_email(b.name, "Completed")
            # Sebar ke reservation: Booking Completed → reservation
            # Completed (reservation terminal tak diketuk ke belakang).
            from travel_booking.module_travel_booking.doctype.booking_reservation.booking_reservation import (
                sync_status_for_booking,
            )
            sync_status_for_booking(b.name)
            count_completed += 1
        except Exception as e:
            frappe.log_error(
                title="Booking Auto-Complete Error",
                message="Failed to auto-complete booking " + b.name + ": " + str(e),
            )

    if bookings:
        frappe.db.commit()

    return {"completed": count_completed, "total": len(bookings)}


def mark_abandoned_pending_bookings(booking_name=None):
    """Scheduled task (harian, rujuk hooks.py scheduler_events) — auto-tukar
    status booking "Pending" yang terbiar ke 'Abandoned' (rujuk deskripsi
    status Booking: "Abandoned = Pending Payment Too Long"). Booking terbiar
    = masih 'Pending' dengan payment_status 'Pending' (tiada bayaran langsung
    — sebaik Payment Entry masuk, _recompute_booking_status() naikkan status
    ke 'Accepted', jadi booking yang pernah bayar takkan tersentuh) DAN
    tarikh cipta sudah sampai had `pending_abandoned_days` di Travel
    Settings. Had 0 / kosong = ciri dimatikan — scheduler balik awal tanpa
    sentuh apa-apa (lalai selamat untuk site baharu).

    'Abandoned' tiada Email Template sendiri (tiada dalam STATUS_TEMPLATE_MAP
    di email_service.py) — tiada emel dihantar. Status dikemas kini terus di
    DB seperti mark_completed_trips() (frappe.db.set_value tidak picu
    doc_events, jadi tiada cascade/emel sampingan). booking_name (opsyenal)
    untuk test/panggil manual terhadap satu booking sahaja.
    """
    days = frappe.utils.cint(
        frappe.db.get_single_value("Travel Settings", "pending_abandoned_days")
    )
    if days <= 0:
        return {"abandoned": 0, "total": 0, "disabled": True}

    today = frappe.utils.today()
    params = {"today": today, "days": days}
    extra_filter = ""
    if booking_name:
        extra_filter = "AND b.name = %(booking_name)s"
        params["booking_name"] = booking_name

    # Anchor umur ialah tarikh cipta: booking yang dicipta pada hari
    # (today - N) atau lebih awal masih Pending → sudah "lebih dari N hari".
    bookings = frappe.db.sql("""
        SELECT b.name
        FROM `tabBooking` b
        WHERE b.status = 'Pending'
          AND b.payment_status = 'Pending'
          AND DATE(b.creation) <= DATE_SUB(%(today)s, INTERVAL %(days)s DAY)
          {extra}
    """.format(extra=extra_filter), params, as_dict=True)

    count_abandoned = 0
    for b in bookings:
        try:
            # Syarat 4 — Abandoned → payment_status 'Canceled' (set terus di
            # DB, selari dengan status; db.set_value tak picu doc_events).
            frappe.db.set_value("Booking", b.name,
                {"status": "Abandoned", "payment_status": "Canceled"})
            count_abandoned += 1
        except Exception as e:
            frappe.log_error(
                title="Booking Auto-Abandon Error",
                message="Failed to auto-abandon booking " + b.name + ": " + str(e),
            )

    if count_abandoned:
        frappe.db.commit()

    return {"abandoned": count_abandoned, "total": len(bookings)}


def reconcile_missing_invoices():
    """Scheduled task (harian, rujuk hooks.py scheduler_events) — jaring
    (sweep) SO booking yang dah dibayar PENUH tapi masih tiada Sales Invoice
    aktif, dan jana invois melalui _maybe_auto_invoice_so(). Auto-invoice
    biasa hanya dicetuskan SEKALI dalam hook Payment Entry submit — kalau ia
    gagal masa itu (error sekejap, kod lapuk, worker restart, dsb.), invois
    takkan terhasil selama-lamanya tanpa jaringan ni (kes sebenar: 3 SO
    fully-paid sejak Sep/Okt 2026 tertinggal invois).

    Idempotent — _maybe_auto_invoice_so sendiri langkau SO yang dah ada
    invois aktif dan SO tak fully-paid, jadi selamat jalan setiap hari.
    """
    rows = frappe.db.sql("""
        SELECT so.name
        FROM `tabSales Order` so
        WHERE so.custom_booking IS NOT NULL AND so.custom_booking != ''
          AND so.docstatus = 1
          AND so.advance_paid >= so.grand_total - 0.001
          AND NOT EXISTS (
              SELECT 1 FROM `tabSales Invoice Item` sii
              JOIN `tabSales Invoice` si ON si.name = sii.parent
              WHERE sii.sales_order = so.name AND si.docstatus != 2
          )
    """, as_dict=True)

    count_invoiced = 0
    for r in rows:
        try:
            before = frappe.db.sql("""
                SELECT COUNT(*) FROM `tabSales Invoice Item` sii
                JOIN `tabSales Invoice` si ON si.name = sii.parent
                WHERE sii.sales_order = %s AND si.docstatus != 2
            """, r.name)[0][0]
            _maybe_auto_invoice_so(r.name)
            after = frappe.db.sql("""
                SELECT COUNT(*) FROM `tabSales Invoice Item` sii
                JOIN `tabSales Invoice` si ON si.name = sii.parent
                WHERE sii.sales_order = %s AND si.docstatus != 2
            """, r.name)[0][0]
            if after > before:
                count_invoiced += 1
        except Exception as e:
            frappe.log_error(
                title="Booking Invoice Reconcile Error",
                message="Reconcile invoice failed for SO " + r.name + ": " + str(e),
            )

    if rows:
        frappe.db.commit()

    if rows:
        frappe.logger("booking").info(
            {"event": "reconcile_missing_invoices", "found": len(rows), "invoiced": count_invoiced}
        )

    return {"found": len(rows), "invoiced": count_invoiced}


# ══════════════════════════════════════════════
# BOOKING NUMBER + PORTAL USER
# ══════════════════════════════════════════════

def _generate_booking_number():
    while True:
        suffix = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        year_month = datetime.now().strftime("%y%m")  # contoh: 2608
        booking_number = "R" + suffix + year_month
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
        # User dah wujud (cth signup via portal tanpa booking). Pastikan
        # role Customer ada sekarang sebab user sedang buat booking.
        user_doc = frappe.get_doc("User", email)
        current_roles = [r.role for r in user_doc.roles]
        if "Customer" not in current_roles:
            user_doc.append("roles", {"role": "Customer"})
            user_doc.flags.ignore_permissions = True
            user_doc.save()
            frappe.db.commit()
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
        "roles":              [{"role": "Customer"}]
    })
    new_user.flags.ignore_permissions = True
    new_user.flags.ignore_password_policy = True
    new_user.insert()
    frappe.db.commit()
    return True
