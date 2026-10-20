# travel_booking/api/currency_axis.py
# PAKSI CURRENCY MULTI-COMPANY — sumber tunggal kebenaran untuk mapping
# currency -> company / price list / payment accounts.
#
# Model: Travel Settings.currency_accounts (child table Travel Currency
# Account) mengisytiharkan SETIAP currency yang boleh dijual. Setiap baris
# menunjuk company yang mengeluarkan SO/bil untuk currency itu. Pemilihan
# currency oleh customer MENENTUKAN company yang mana mereka berurusan
# (cth MYR -> HQ Malaysia, SGD -> Branch Singapore, IDR -> Branch Indonesia).
#
# SO sentiasa dicipta dalam company currency company yang berkenaan dengan
# conversion_rate=1.0 — TIADA conversion accounting; ini multi-company
# sebenar, bukan currency converter.
#
# Tiada @frappe.whitelist() di sini (bukan endpoint) — fungsi dalaman
# untuk api/*.py, doctype controllers, patch dan utils.

import frappe
from frappe.utils import flt

from travel_booking.api.constants import DEFAULT_CURRENCY, DEFAULT_SELLING_PRICE_LIST

# Cache frappe standard dokumen Travel Settings pada satu request; axis
# dibaca banyak kali per request (listing + confirm + PE) — elak query
# berulang. Antara request, frappe.get_cached_doc cukup (cache Redis).


def _travel_settings_default_currency():
    """Override default currency daripada Travel Settings.default_currency
    (null bila tak di-set / doctype belum dipatch)."""
    try:
        return frappe.get_cached_doc("Travel Settings").default_currency or None
    except Exception:
        return None


def _company_default_currency():
    """Currency company default (Global Defaults.default_company)."""
    default_company = frappe.db.get_single_value("Global Defaults", "default_company")
    if default_company:
        return frappe.get_cached_value("Company", default_company, "default_currency")
    return None


def get_currency_axis():
    """Pulangkan list[dict] baris paksi currency dari Travel Settings.

    Setiap dict: {currency, symbol, company, selling_price_list,
    bank_account, manual_transfer_paid_to_account,
    payment_gateway_account, is_default}. Baris dengan currency ==
    default currency (Travel Settings.default_currency, fallback currency
    company default) ditandakan is_default=True dan sentiasa dihantar
    FIRST (untuk default selector frontend).

    Baris tanpa currency/company diabaikan senyap (grid Draft boleh ada
    barisan separa isi semasa admin edit — jangan crash bacaan runtime).
    """
    ts = frappe.get_cached_doc("Travel Settings")
    default_currency = get_default_currency()

    out = []
    for row in (ts.currency_accounts or []):
        if not row.currency or not row.company:
            continue
        out.append({
            "currency": row.currency,
            "symbol": _currency_symbol(row.currency),
            "company": row.company,
            "selling_price_list": row.selling_price_list,
            "bank_account": row.bank_account,
            "manual_transfer_paid_to_account": row.manual_transfer_paid_to_account,
            "payment_gateway_account": row.payment_gateway_account,
            "is_default": bool(default_currency and row.currency == default_currency),
        })

    # Baris default dulu — caller frontend guna elemen pertama sebagai
    # pilihan asas (behavior hari ini: company default currency).
    out.sort(key=lambda r: not r["is_default"])
    return out


def get_currency_options():
	"""Senarai currency yang DIISYTIHARKAN untuk dijual (paksi axis).

	Pulangkan [{currency, symbol, company, is_default}] — untuk:
	  - frontend selector (tour/cruise/wizard/addon),
	  - validasi Trip Package.currency & Trip Addon Package Rate.currency,
	  - validasi pilihan currency dari payload API.
	"""
	return [
		{
			"currency": r["currency"],
			"symbol": r["symbol"],
			"company": r["company"],
			"is_default": r["is_default"],
		}
		for r in get_currency_axis()
	]


def get_declared_currencies():
	"""Set currency sah (nama terus, bukan dict) — kegunaan validasi
	cth `currency in get_declared_currencies()`."""
	return {r["currency"] for r in get_currency_axis()}


def get_default_currency():
    """Currency default laman — urutan: Travel Settings.default_currency
    (tetapan admin), currency company default (baris axis is_default),
    fallback DEFAULT_CURRENCY (pemasangan baru sebelum patch seed jalan).
    """
    return (_travel_settings_default_currency()
            or _company_default_currency()
            or DEFAULT_CURRENCY)


def get_rate_to_default(currency):
    """Kadar tukaran currency → default currency (nilai semasa,
    best-effort) → (rate|None, tarikh_kadar|None).

    Sumber: rekod doctype Currency Exchange (pasangan terus, kemudian
    pasangan songsang 1/rate), tarikh terkini dulu. SENGAJA tiada HTTP
    call di sini — page admin yang render banyak currency tidak patut
    bergantung pada API luar secara segerak; kadar dikemas kini oleh
    auto-fetch Currency Exchange Settings (scheduler ERPNext) atau
    rekod manual. Tiada kadar → (None, None) — caller papar nilai
    native sahaja.
    """
    if not currency:
        return None, None
    default = get_default_currency()
    if currency == default:
        return 1.0, None

    # Cache per-request — kadar sama dipakai berulang dalam satu page.
    cache = getattr(frappe.local, "tb_rate_to_default_cache", None)
    if cache is None:
        cache = frappe.local.tb_rate_to_default_cache = {}
    key = f"{currency}->{default}"
    if key in cache:
        return cache[key]

    rate = rate_date = None
    try:
        rows = frappe.get_all(
            "Currency Exchange",
            filters={
                "from_currency": ["in", [currency, default]],
                "to_currency": ["in", [currency, default]],
            },
            fields=["from_currency", "to_currency", "exchange_rate", "date"],
            order_by="date desc, creation desc",
            limit=2,
        )
        for r in rows:
            if r.from_currency == currency and r.to_currency == default and flt(r.exchange_rate) > 0:
                rate, rate_date = flt(r.exchange_rate), r.date
                break
        if not rate:
            for r in rows:
                if (r.from_currency == default and r.to_currency == currency
                        and flt(r.exchange_rate) > 0):
                    rate, rate_date = flt(1.0 / flt(r.exchange_rate)), r.date
                    break
    except Exception:
        pass

    result = (rate, str(rate_date) if rate else None) if rate else (None, None)
    cache[key] = result
    return result


def _axis_row(currency):
	"""Baris axis untuk satu currency, atau None."""
	for r in get_currency_axis():
		if r["currency"] == currency:
			return r
	return None


def resolve_company_for_currency(currency):
	"""Company yang mengeluarkan SO/bil untuk currency ini.

	Throw jika currency tidak diisytiharkan dalam axis — jangan fallback
	senyap: SO yang salah company lebih mahal daripada error jelas semasa
	booking (customer boleh retry dengan currency lain).
	"""
	row = _axis_row(currency)
	if not row:
		frappe.throw(
			"Currency '{0}' is not available for booking. Available "
			"currencies: {1}. Please configure it in Travel Settings > "
			"Multi Currency Account, or choose another currency.".format(
				currency, ", ".join(sorted(get_declared_currencies())) or "(none)"
			),
			title="Currency Not Available",
		)
	return row["company"]


def currency_to_price_list(currency):
	"""Price List selling untuk currency ini; fallback price list default
	company (baris axis default / "Standard Selling").

	Fallback dibiarkan (bukan throw) kerana price list pada SO booking
	adalah mekanikal — rate sebenar sentiasa di-set eksplisit per item
	dari Trip Package Price / addon rate; Item Price dalam price list
	auto-seed oleh insert_item_price ERPNext pada SO pertama.
	"""
	row = _axis_row(currency)
	if row and row["selling_price_list"]:
		return row["selling_price_list"]
	return DEFAULT_SELLING_PRICE_LIST


def resolve_so_currency_context(currency):
	"""(currency, company, price_list, conversion_rate) untuk cipta SO.

	Satu pintu tunggal untuk booking_engine + addon_manager. SO sentiasa
	dalam company currency company branch berkenaan, rate=1.0 (harga
	native pakej/addon dalam currency yang sama — tiada conversion).
	"""
	company = resolve_company_for_currency(currency)
	price_list = currency_to_price_list(currency)
	return currency, company, price_list, 1.0


def _currency_symbol(currency):
	"""Simbol currency (cth MYR->RM, SGD->S$, IDR->Rp). Fallback kod
	currency sendiri jika tiada rekod/simbol."""
	if not currency:
		return ""
	symbol = frappe.get_cached_value("Currency", currency, "symbol")
	return symbol or currency
