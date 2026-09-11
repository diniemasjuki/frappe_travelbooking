# travel_booking/utils/geo_currency.py
#
# Default currency listing mengikut LOKASI pelawat untuk page web awam
# (homepage tour/cruise, katalog /tours /cruises /trips, detail trip).
# Dikawal oleh Travel Website > Default Currency by Location.
#
# Dua mekanisme (kedua-duanya bawah toggle geo_currency_enabled):
#
# 1. IP lookup SERVER-SIDE (utama, automatic, tiada prompt): negara
#    pelawat dari IP — header CF-IPCountry jika laman di sebalik
#    Cloudflare, jika tidak provider geo-IP ipwho.is (free, no key)
#    dengan cache Redis per-IP. Negara dipetakan ikut Travel Website >
#    Country Currency Mapping (cth MY -> MYR, SG -> SGD); negara lain /
#    lookup gagal -> currency default axis (hari ini MYR).
#
# 2. Browser Geolocation API (refinement, client-side): public/js/
#    geo_currency.js meminta kebenaran SEKALI sahaja; jika dibenarkan,
#    koordinat di-reverse-geocode (BigDataCloud, client-side, free) ke
#    negara dan mapping sama dipakai. Lebih tepat dari IP (VPN/roaming).
#
# Keutamaan resolusi (resolve_website_currency) — pilihan pelawat
# SENTIASA menang, geolocation cuma default:
#     ?currency= URL param  >  cookie rc_currency (pilihan tersimpan)
#     >  geo default  >  currency default axis.
#
# Prinsip kegagalan: lookup geo ADALAH paparan-default sahaja — sebarang
# kegagalan (provider down, timeout, IP tak dikenali) jatuh senyap ke
# currency default axis. JANGAN throw / break render.

import ipaddress

import frappe
import requests

from travel_booking.api.currency_axis import get_declared_currencies, get_default_currency

# Provider geo-IP: ipwho.is — free, no key, HTTPS. Respons:
# {"ip": "...", "success": true, "country_code": "MY", ...}
_PROVIDER_URL = "https://ipwho.is/{ip}"

# Cache Redis per-IP. Negara bagi satu IP jarang berubah — cache lama
# supaya panggilan provider diminimumkan (corak sama seperti cache FX
# travel_booking:fx:* dalam api/pricing.py).
_GEO_CACHE_KEY = "travel_booking:geo:country:{ip}"
_COUNTRY_TTL = 7 * 24 * 60 * 60  # kejayaan — 7 hari
_FAIL_TTL = 60 * 60  # kegagalan (down/timeout) — retry selepas 1 jam

_TIMEOUT = 2.5  # saat — jangan halang render lama; cached selepas itu


def resolve_website_currency() -> str:
	"""Currency listing untuk page awam semasa — rantaian keutamaan:

	1. ?currency= param (pilihan eksplisit: selector, form katalog,
	   link berkongsi)
	2. cookie rc_currency (pilihan tersimpan — ditulis oleh public/js/
	   geo_currency.js setiap kali URL bawa ?currency=)
	3. default geolocation (negara dari IP pelawat)
	4. currency default axis (Travel Settings)

	Nilai yang dikembalikan BELUM di-validate diisytiharkan dalam axis —
	get_catalog_trips() / get_trip_detail() yang normalize (behavior
	sedia ada untuk param ?currency= pun begitu).
	"""
	# 1. Param eksplisit dari query string semasa (LocalProxy tidak bound
	#    dalam konteks bukan-request cth background job — try/except).
	try:
		currency = (frappe.form_dict.get("currency") or "").strip().upper()
	except Exception:
		currency = ""
	if currency:
		return currency

	# 2. Pilihan tersimpan (cookie first-party). Cookie dikongsi nama
	# dengan localStorage["rc_currency"] yang selector sedia guna.
	currency = _cookie_currency()
	if currency:
		return currency

	# 3. Default geolocation.
	return get_geo_default_currency()


def get_geo_default_currency() -> str:
	"""Currency default mengikut lokasi pelawat semasa.

	Disabled / lookup gagal / negara tiada mapping / currency mapped
	tak diisytiharkan dalam axis → currency default axis. Sentiasa
	pulangkan string currency yang sah (fallback, bukan None/throw).
	"""
	config = _geo_config()
	if not config.get("enabled"):
		return get_default_currency()

	country = get_request_country()
	if not country:
		return get_default_currency()

	currency = (config.get("map") or {}).get(country.upper())
	if not currency:
		return get_default_currency()

	# Currency mesti DIJUAL (axis Travel Settings > Multi Currency
	# Account) — kalau admin belum sediakan baris SGD (company/price
	# list/bank/gateway), jangan hantar pelawat ke currency yang tak
	# boleh ditempah.
	if currency not in get_declared_currencies():
		return get_default_currency()

	return currency


def get_request_country() -> str | None:
	"""Kod negara ISO 3166-1 alpha-2 UPPERCASE (cth "MY") untuk request
	semasa, atau None jika tak dapat ditentukan.

	Sumber ikut keutamaan:
	  1. Header CF-IPCountry — instant & free jika laman di sebalik
	     Cloudflare (nilai "XX"/"T1" = Cloudflare sendiri tak pasti).
	  2. Lookup provider geo-IP dari frappe.local.request_ip (frappe
	     dah handle X-Forwarded-For), cache Redis per-IP.

	Sebarang kegagalan → None (caller fallback ke default — ini paparan
	sahaja, bukan gate kritikal).
	"""
	header_country = _cf_country()
	if header_country:
		return header_country

	ip = _client_ip()
	if not ip:
		return None

	cached = _cached_country(ip)
	if cached is not None:
		return cached or None

	country = _lookup_country(ip)
	_cache_country(ip, country)
	return country


# ── Bahagian dalaman ──


def _geo_config() -> dict:
	"""{enabled, map} dari website_config (cache Redis, dikosongkan
	semasa Travel Website disimpan)."""
	try:
		from travel_booking.utils.website_config import get_website_config

		return get_website_config().get("geo_currency") or {}
	except Exception:
		return {}


def _cf_country() -> str | None:
	"""Negara dari header Cloudflare CF-IPCountry (jika ada)."""
	try:
		code = (frappe.get_request_header("CF-IPCountry") or "").strip().upper()
	except Exception:
		return None
	# Cloudflare guna XX (tak dikenali) / T1 (Tor).
	return code if code and code not in ("XX", "T1") else None


def _client_ip() -> str | None:
	"""IP public pelawat semasa, atau None (tiada request / IP private /
	IP loopback / bukan format IP)."""
	try:
		ip = (frappe.local.request_ip or "").strip()
	except Exception:
		return None
	if not ip:
		return None
	try:
		parsed = ipaddress.ip_address(ip)
	except ValueError:
		return None
	if parsed.is_private or parsed.is_loopback:
		return None
	return ip


def _lookup_country(ip: str) -> str | None:
	"""Negara untuk satu IP dari provider geo-IP. None sebarang gagal
	(network/timeout/respons tak sah)."""
	try:
		response = requests.get(_PROVIDER_URL.format(ip=ip), timeout=_TIMEOUT)
		response.raise_for_status()
		data = response.json()
	except Exception:
		return None
	if data.get("success") is False:
		return None
	code = (data.get("country_code") or data.get("countryCode") or "").strip().upper()
	return code or None


def _cached_country(ip: str):
	"""Negara tercache untuk IP — None = miss, "" = kegagalan tercache,
	"MY" dsb = kejayaan."""
	try:
		return frappe.cache().get_value(_GEO_CACHE_KEY.format(ip=ip))
	except Exception:
		return None


def _cache_country(ip: str, country: str | None):
	"""Simpan hasil lookup (kegagalan turut disimpan supaya provider
	yang down tidak dipanggil setiap request)."""
	try:
		frappe.cache().set_value(
			_GEO_CACHE_KEY.format(ip=ip),
			country or "",
			expires_in_sec=_COUNTRY_TTL if country else _FAIL_TTL,
		)
	except Exception:
		pass


def _cookie_currency() -> str:
	"""Pilihan currency tersimpan dari cookie rc_currency ('' jika tiada)."""
	try:
		return (frappe.request.cookies.get("rc_currency") or "").strip().upper()
	except Exception:
		return ""
