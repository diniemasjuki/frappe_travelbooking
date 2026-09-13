# travel_booking/utils/seo.py
#
# Helper SEO untuk page awam (katalog /trips /tours /cruises, homepage
# /tour /cruise /cruise-schedule, dan detail trip /<route>).
#
# Corak gunaan:
#   from travel_booking.utils.seo import apply_seo
#   apply_seo(context, title=..., description=..., image=..., ...)
#
# apply_seo() menyuntik dict `context.seo` yang dirender oleh include
# templates/includes/seo_meta.html (dimuat dalam <head> base_travel.html):
#   - meta description + robots (noindex)
#   - canonical URL (dari request path — query string dibuang)
#   - Open Graph + Twitter Card
#   - JSON-LD structured data (schema.org) ikut jenis page
#
# Fungsi JSON-LD dedikasi:
#   build_trip_json_ld()   — Product+Offer / BreadcrumbList / FAQPage utk
#                            page detail trip (dipanggil Trip.get_context)
#   build_website_json_ld() — WebSite + Organization utk katalog/homepage

import html
import json

import frappe
from frappe.utils import get_url, strip_html


DEFAULT_SITE_NAME = "Rarecation"

# Saiz paparan standard SERP — dipotong rapi di sini supaya meta
# description tak dipotong rawak oleh Google.
_DESC_LIMIT = 160


def clean_description(value, limit=_DESC_LIMIT):
    """Buang HTML + whitespace berlebihan, potong ke had aksiar SELAMAT
    (word boundary) — untuk meta description & og:description.
    html.unescape selepas strip_html supaya entiti (&amp; &quot; …) jadi
    aksara sebenar; Jinja autoescape menukar semula dengan selamat ketika
    render tag <meta>."""
    text = " ".join(html.unescape(strip_html(value or "")).split())
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0]
    return (cut or text[:limit]).rstrip(",;:. ") + "…"


def _site_name():
    """Nama site untuk og:site_name / fallback title — dari Website
    Settings (app_name), fallback 'Rarecation'."""
    return (
        frappe.db.get_single_value("Website Settings", "app_name")
        or DEFAULT_SITE_NAME
    )


def _request_path():
    """Path request semasa (tanpa query string) — asas canonical URL.
    Fallback '/' bila luar kitaran request (cth. render untuk email).
    getattr — frappe.local RAISE AttributeError utk attribute yang belum
    diset (bukan pulangkan None), jadi akses terus `frappe.local.request`
    akan pecah di luar kitaran web request."""
    request = getattr(frappe.local, "request", None)
    if request:
        return request.path or "/"
    return "/"


def apply_seo(
    context,
    title=None,
    description=None,
    image=None,
    page_type="website",
    noindex=False,
    json_ld=None,
    breadcrumb=None,
):
    """Suntik dict `seo` ke context page awam utk dirender oleh include
    seo_meta.html. Semua parameter pilihan — fallback sensibel:

      title       → og:title (fallback: context.title → site name)
      description → meta description + og:description (dibersihkan HTML)
      image       → og:image / twitter:image (jadi URL mutlak)
      page_type   → og:type ("website" default, "product" utk detail trip)
      noindex     → robots noindex,follow (page transaksional/preview)
      json_ld     → list dict schema.org — setiap satu jadi satu blok
                    <script type="application/ld+json">
      breadcrumb  → list [{"label", "url"}] — auto-jadi BreadcrumbList
                    JSON-LD (Home sentiasa level pertama)
    """
    seo = frappe._dict()
    site = _site_name()
    seo.site_name = site
    seo.title = (title or getattr(context, "title", None) or site or "").strip()
    seo.description = clean_description(description)
    seo.image = get_url(image) if image else ""
    seo.canonical = get_url(_request_path().rstrip("/") or "/")
    seo.page_type = page_type
    seo.noindex = bool(noindex)
    seo.locale = "en_US"

    blocks = list(json_ld or [])
    if breadcrumb:
        blocks.append(build_breadcrumb_json_ld(breadcrumb))
    seo.json_ld = [b for b in blocks if b]

    context.seo = seo
    return seo


def build_breadcrumb_json_ld(crumbs):
    """BreadcrumbList schema.org dari list {"label", "url"} — url boleh
    relatif; Home tanpa url dibenarkan (posisi pertama biasanya Home)."""
    if not crumbs:
        return None
    items = []
    for i, c in enumerate(crumbs, start=1):
        item = {"@type": "ListItem", "position": i, "name": c.get("label") or ""}
        if c.get("url"):
            item["item"] = get_url(c["url"])
        items.append(item)
    return {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": items}


def build_website_json_ld(site_name=None, description=None, search_path="/trips"):
    """WebSite + potentialAction SearchAction untuk page katalog/homepage —
    endpoint carian sebenar (/trips?q=). Organization berasingan supaya
    boleh dirujuk logo/fallback name."""
    data = [
        {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "name": site_name or _site_name(),
            "url": get_url("/"),
        },
        _organization_json_ld(),
    ]
    if search_path:
        data[0]["potentialAction"] = {
            "@type": "SearchAction",
            "target": {
                "@type": "EntryPoint",
                "urlTemplate": get_url(search_path) + "?q={search_term_string}",
            },
            "query-input": "required name=search_term_string",
        }
    _ = description  # dikekalkan utk signature stabil — desc pergi ke meta tag
    return data


def _organization_json_ld():
    """Organization asas dari Website Settings (name + app_logo).
    get_single_value dilindungi try/except — field boleh berubah antara
    versi Frappe; logo hilang tak sepatutnya rosakkan page."""
    org = {
        "@context": "https://schema.org",
        "@type": "Organization",
        "name": _site_name(),
        "url": get_url("/"),
    }
    try:
        logo = frappe.db.get_single_value("Website Settings", "app_logo") or ""
    except Exception:
        logo = ""
    if logo:
        org["logo"] = get_url(logo)
    return org


def build_trip_json_ld(
    trip_name,
    description,
    image,
    page_url_path,
    is_cruise=False,
    price=None,
    currency=None,
    organizer=None,
    faqs=None,
    destinations=None,
    breadcrumb=None,
):
    """Structured data page detail trip.

    - Product + Offer: satu-satunya rich result yang Google sokong utk
      halaman jualan pakej travel (price, currency, availability, url).
      Kategori diberi cat "Tour"/"Cruise".
    - FAQPage: bila trip ada FAQ (rich result accordion Google).
    - BreadcrumbList: dari `breadcrumb` [{"label", "url"}].
    """
    blocks = []

    product = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": trip_name,
        "category": "Cruise" if is_cruise else "Tour",
        "url": get_url(page_url_path),
    }
    if description:
        product["description"] = clean_description(description, limit=5000)
    if image:
        product["image"] = [get_url(image)]
    if organizer:
        product["brand"] = {"@type": "Brand", "name": organizer}
    if price:
        offer = {
            "@type": "Offer",
            "url": get_url(page_url_path),
            "price": round(float(price), 2),
            "priceCurrency": currency or "MYR",
            "availability": "https://schema.org/InStock",
        }
        product["offers"] = offer
    if destinations:
        product["itemIncluded"] = [
            {"@type": "TouristDestination", "name": d} for d in destinations[:5] if d
        ]
    blocks.append(product)

    clean_faqs = [
        {
            "@type": "Question",
            "name": clean_description(f.get("question"), limit=250),
            "acceptedAnswer": {
                "@type": "Answer",
                "text": clean_description(f.get("answer"), limit=5000),
            },
        }
        for f in (faqs or [])
        if f.get("question") and f.get("answer")
    ]
    if clean_faqs:
        blocks.append(
            {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": clean_faqs}
        )

    if breadcrumb:
        blocks.append(build_breadcrumb_json_ld(breadcrumb))

    return blocks


def dumps_json_ld(blocks):
    """Serialize senarai blok JSON-LD — dipakai include seo_meta.html via
    filter tojson; helper ini untuk gunaan python/pembandingan."""
    return [json.dumps(b, ensure_ascii=False, default=str) for b in blocks]
