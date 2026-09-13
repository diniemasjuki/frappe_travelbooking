# travel_booking/www/booknow.py
#
# Page wizard tempahan /booknow — clone flow /booking dengan tema Rarecation.
# Terima parameter URL yang sama (?trip_master= & ?trip_group_date=) supaya
# pautan dari trip detail page terus berfungsi. Sistem flow & rules 100% sama
# dengan /booking; bezanya hanya tema visual (gold/dark/cream).
import frappe
import frappe.sessions
import json

from travel_booking.api._helpers import (
    get_company_currency,
    get_customer_by_email,
    get_customer_phone,
    get_own_affiliate_code,
    resolve_booking_actor,
)
from travel_booking.utils.trip_catalog import get_ready_bundle
from travel_booking.www.trips import _get_currency_filter


def _filter_packages_by_currency(trips, trip_group_dates, trip_packages, currency):
	"""Tapis pakej ikut currency listing — polisi SAMA dengan get_trip_detail:

	- trip yang ada >= 1 pakej Active dalam currency terpilih → hanya pakej
	  currency ITU dipaparkan, dan TGD tanpa pakej currency itu dikeluarkan
	  (elak wizard bawa sailing yang tak boleh dibayar dalam currency pilihan);
	- trip yang TIADA pakej dalam currency itu → fallback papar SEMUA pakej
	  native (native_only) supaya pautan/cart lama tak mati — wizard tetap
	  caj dalam currency native pakej (model multi-company).

	KEMBALI (trips, trip_group_dates, trip_packages, native_only)."""
	if not trips or not currency:
		return trips, trip_group_dates, trip_packages, False

	# Trip yang ada sekurang-kurangnya satu pakej dalam currency pilihan
	has_currency = set()
	for t in trips:
		for g in trip_group_dates.get(t.name) or []:
			if any(
				p.get("currency") == currency
				for p in (trip_packages.get(g["name"]) or [])
			):
				has_currency.add(t.name)
				break

	native_only = False
	kept_tgds: dict = {}
	kept_pkgs: dict = {}
	for t in trips:
		fallback = t.name not in has_currency
		native_only = native_only or fallback
		for g in trip_group_dates.get(t.name) or []:
			pkgs = trip_packages.get(g["name"]) or []
			keep = (
				pkgs if fallback
				else [p for p in pkgs if p.get("currency") == currency]
			)
			if keep:
				kept_tgds.setdefault(t.name, []).append(g)
				kept_pkgs[g["name"]] = keep
			# TGD tanpa pakej dalam currency pilihan → terkeluar daripada
			# wizard (dropdown tarikh & validasi cart hanya melihat TGD ini).
	return trips, kept_tgds, kept_pkgs, native_only


def _get_session_profile():
    """Profil ringkas session user untuk PREFILL Step 2 wizard (nama penuh
    + telefon). Data user SENDIRI dari session — bukan lookup PII ikut
    email arbitari (endpoint send_otp sengaja tidak pulangkan nama/telefon,
    keputusan produk 2026-09-04 kekal).

    Sumber phone ikut keutamaan:
      1. Customer utama ikut email session (Contact Phone → Contact →
         Dynamic Link 'Customer') — sumber canonical yang sama diguna
         portal Profile (get_customer_phone) dan caj booking (cust_phone).
      2. Contact yang di-link terus ke User ini (Contact.user) — primary
         phone (untuk akaun yang disediakan tanpa rekod Customer).
      3. Fallback User.phone / User.mobile_no (user portal yang belum ada
         rekod Customer/Contact).

    Pulangkan None untuk Guest supaya pageData membawa null (bukan string).
    """
    if frappe.session.user == "Guest":
        return None

    user = frappe.session.user
    user_vals = frappe.db.get_value(
        "User", user, ["full_name", "phone", "mobile_no"], as_dict=True
    )
    full_name = (user_vals.full_name or "").strip() if user_vals else ""

    phone = ""
    customer = get_customer_by_email(user)
    if customer:
        phone = get_customer_phone(customer) or ""
    if not phone:
        contact_name = frappe.db.get_value("Contact", {"user": user}, "name")
        if contact_name:
            phone = frappe.db.get_value(
                "Contact Phone",
                {"parent": contact_name, "parenttype": "Contact"},
                "phone",
                order_by="is_primary_phone desc",
            ) or ""
    if not phone and user_vals:
        phone = (user_vals.phone or user_vals.mobile_no or "").strip()

    # Tanpa nama DAN phone, prefill tiada guna — jangan hantar objek kosong.
    if not full_name and not phone:
        return None
    return {"full_name": full_name, "phone": phone}


def get_context(context):
    # Parameter URL — dikekalkan sama seperti /booking untuk compatibility.
    trip_master     = frappe.form_dict.get("trip_master")
    trip_group_date = frappe.form_dict.get("trip_group_date")

    # Data "ready trip" dari lapisan kongsi trip_catalog — identik /booking.
    trips, trip_group_dates, trip_packages, trip_is_cruise = get_ready_bundle()

    # Currency listing paksi multi-company (rantaian yang sama dengan
    # katalog: ?currency= → cookie rc_currency → geo default). Hanya pakej
    # dalam currency ini dipaparkan — polisi get_trip_detail; trip tanpa
    # pakej currency itu fallback papar semua pakej native.
    currency = _get_currency_filter()
    trips, trip_group_dates, trip_packages, currency_native_only = (
        _filter_packages_by_currency(
            trips, trip_group_dates, trip_packages, currency
        )
    )

    context.trips            = trips
    context.trip_group_dates = json.dumps(trip_group_dates)
    context.trip_packages    = json.dumps(trip_packages)
    context.trip_cruise_flags = json.dumps(trip_is_cruise)
    context.trip_master      = trip_master or ""
    context.trip_group_date  = trip_group_date or ""
    context.currency         = currency
    context.currency_native_only = currency_native_only
    context.no_cache         = 1
    context.title            = "Book Now — Rarecation"

    # Company currency — semua harga dalam company currency.
    company_currency = get_company_currency()
    context.company_currency = company_currency
    context.company_symbol = (
        frappe.db.get_value("Currency", company_currency, "symbol") or company_currency
    )

    context.csrf_token = (
        frappe.sessions.get_csrf_token() if frappe.session.user != "Guest" else ""
    )

    # Email user semasa (untuk auto-verified email di wizard) — dikira
    # server-side supaya client TIDAK perlu panggil frappe.auth.get_logged_user
    # (endpoint tu tidak allow_guest — Guest dapat 403 di console).
    context.current_user = (
        frappe.session.user if frappe.session.user != "Guest" else ""
    )

    # Prefill Step 2 (nama penuh + telefon) untuk session user yang sudah
    # login — server-side (bukan API call client) supaya tiada endpoint PII
    # baharu yang boleh di-probe. Client BOLEH edit semula nilai ini — field
    # tidak pernah dikunci (keputusan produk: prefill adalah kemudahan).
    context.user_profile_json = json.dumps(_get_session_profile())

    # Booking actor (fasa 1 modul booking-channel): session user dengan
    # role "Affiliate" / "Sales User" yang layak aktifkan checkbox
    # "Booking on behalf" di wizard — email customer boleh diisi tanpa OTP.
    # Dikira server-side (sama corak dengan current_user di atas) dan
    # disuntik ke pageData sebagai JSON; kosong (null) untuk Guest/user
    # biasa — wizard tak papar checkbox langsung dalam kes tu.
    # PENTING: ini hanya untuk PAPARAN wizard. Gate sebenar (OTP skip)
    # disahkan SEMULA di confirm_booking() melalui resolve_booking_actor()
    # — nilai dari client tidak pernah dipercayai begitu sahaja.
    actor = resolve_booking_actor()
    context.booking_actor_json = json.dumps(actor) if actor else "null"

    # Pre-aktivasi affiliate: kod referral SENDIRI session user kalau dia
    # ada profil affiliate sah (Affiliate Profile "Verified" — rujuk
    # get_own_affiliate_code()). Disuntik ke pageData supaya wizard boleh
    # auto-apply kod itu (applied box + discount row paparan) dan
    # confirm_booking menerima kod yang sama — paparan harga SENTIASA
    # sepadan dengan SO sebenar. Enforcement sebenar tetap berlaku
    # SEMULA di confirm_booking() secara server-side; nilai client ini
    # cuma untuk paparan/prefill, bukan sumber kebenaran.
    # WAJIB string kosong (bukan None) bila kod tak dapat di-retrieve —
    # session user ada tapi tiada profil affiliate Verified. Jinja render
    # None sebagai string literal "None" dalam pageData, dan wizard akan
    # pre-fill input kod affiliate dengan "NONE" — data rosak.
    context.own_affiliate_code = (
        (get_own_affiliate_code() if frappe.session.user != "Guest" else None) or ""
    )
