# travel_booking/utils/website_config.py
#
# Lapisan akses konfigurasi untuk homepage awam (cruise / tour) + nav +
# footer. Membaca singleton Travel Website, tapis baris child (aktif sahaja,
# susun ikut sort_order), dan cache hasilnya per-site.
#
# Diekspos ke Jinja sebagai kaedah global melalui hooks.py:
#   jinja = {"methods": ["travel_booking.utils.assets",
#                        "travel_booking.utils.website_config"]}
#
# Gunaan di template:
#   {% set wc = get_website_config() %}
#   {{ wc.cruise.hero.title }}
#   {% for item in get_nav_menu(active_nav) %} ... {% endfor %}
#   {{ wc.footer.tagline }}

import frappe

_CACHE_KEY = "travel_website_config"


def get_website_config() -> dict:
    """Pulangkan keseluruhan konfigurasi Travel Website sebagai dict bersarang.

    Dicache per-site; dikosongkan semasa Travel Website disimpan (on_update).
    Pulangkan default kosong selamat jika singleton belum wujud (pre-install).
    """
    cache = frappe.cache()
    config = cache.get_value(_CACHE_KEY)
    if config is not None:
        return config

    config = _build_config()
    cache.set_value(_CACHE_KEY, config)
    return config


def get_nav_menu(active_nav: str = "") -> list:
    """Pulangkan item menu nav untuk kunci active_nav yang diberikan.

    'tour'              → menu tour
    apa-apa sahaja lain → menu cruise (fallback lalai untuk page bukan-
                          homepage seperti /trips, /booking, dll.)
    """
    wc = get_website_config()
    if active_nav == "tour":
        return wc["tour"]["menu"]
    return wc["cruise"]["menu"]


def _build_config() -> dict:
    try:
        doc = frappe.get_cached_doc("Travel Website")
    except Exception:
        return _empty_config()

    footer_links = _active_rows(doc.get("footer_links"), has_active=True)
    return {
        "website_logo": doc.get("website_logo") or "",
        "footer": {
            "tagline": doc.get("footer_tagline") or "",
            "links": footer_links,
            "columns": _group_footer_columns(footer_links),
            "support_email": doc.get("support_email") or "contact@rpwp.my",
            "copyright_text": doc.get("copyright_text") or "",
            "social": {
                "facebook": doc.get("social_facebook") or "",
                "instagram": doc.get("social_instagram") or "",
                "whatsapp": doc.get("social_whatsapp") or "",
            },
        },
        "cruise": _homepage_block(doc, "cruise"),
        "tour": _homepage_block(doc, "tour"),
    }


def _group_footer_columns(links: list) -> list:
    """Kumpul link footer ikut column_title, kekal susunan sort_order.
    Pulangkan [{title, links}] supaya template boleh loop terus."""
    columns = {}
    order = []
    for link in links:
        title = link.get("column_title") or "Links"
        if title not in columns:
            columns[title] = []
            order.append(title)
        columns[title].append(link)
    return [{"title": t, "links": columns[t]} for t in order]


def _homepage_block(doc, prefix: str) -> dict:
    """Bina satu blok konfigurasi homepage (cruise atau tour)."""
    return {
        "nav_cta": {
            "label": doc.get(f"{prefix}_nav_cta_label") or "Manage Booking",
            "url": doc.get(f"{prefix}_nav_cta_url") or "/traveller_portal",
        },
        "menu": _active_rows(doc.get(f"{prefix}_menu"), has_active=True),
        "hero": {
            "tag": doc.get(f"{prefix}_hero_tag") or "",
            "title": doc.get(f"{prefix}_hero_title") or "",
            "intro": doc.get(f"{prefix}_hero_intro") or "",
            "search_label": doc.get(f"{prefix}_hero_search_label")
            or ("Search Cruises" if prefix == "cruise" else "Search Tours"),
            "stats": _active_rows(doc.get(f"{prefix}_hero_stats"), has_active=False),
        },
        "featured": {
            "tag": doc.get(f"{prefix}_featured_tag") or "",
            "title": doc.get(f"{prefix}_featured_title") or "",
            "subtitle": doc.get(f"{prefix}_featured_subtitle") or "",
            "cta_label": doc.get(f"{prefix}_featured_cta_label") or "",
            "cta_url": doc.get(f"{prefix}_featured_cta_url") or "",
        },
        "whyus": {
            "tag": doc.get(f"{prefix}_whyus_tag") or "",
            "title": doc.get(f"{prefix}_whyus_title") or "",
            "subtitle": doc.get(f"{prefix}_whyus_subtitle") or "",
            "benefits": _active_rows(doc.get(f"{prefix}_benefits"), has_active=True),
        },
        "dest": {
            "tag": doc.get(f"{prefix}_dest_tag") or "",
            "title": doc.get(f"{prefix}_dest_title") or "",
            "subtitle": doc.get(f"{prefix}_dest_subtitle") or "",
        },
        "testi": {
            "tag": doc.get(f"{prefix}_testi_tag") or "",
            "title": doc.get(f"{prefix}_testi_title") or "",
            "subtitle": doc.get(f"{prefix}_testi_subtitle") or "",
            "testimonials": _active_rows(
                doc.get(f"{prefix}_testimonials"), has_active=False
            ),
        },
        "cta": {
            "icon": doc.get(f"{prefix}_cta_icon") or "",
            "tag": doc.get(f"{prefix}_cta_tag") or "",
            "title": doc.get(f"{prefix}_cta_title") or "",
            "body": doc.get(f"{prefix}_cta_body") or "",
            "primary_label": doc.get(f"{prefix}_cta_primary_label") or "",
            "primary_url": doc.get(f"{prefix}_cta_primary_url") or "",
            "secondary_label": doc.get(f"{prefix}_cta_secondary_label") or "",
            "secondary_url": doc.get(f"{prefix}_cta_secondary_url") or "",
        },
    }


def _active_rows(rows, has_active: bool = True) -> list:
    """Tapis & susun baris child. Jika has_active, buang baris tidak aktif.
    Pulangkan list dict kosong (JSON-safe, selamat dicache).
    """
    if not rows:
        return []
    items = []
    for r in rows:
        if has_active and not r.get("is_active"):
            continue
        items.append(r.as_dict() if hasattr(r, "as_dict") else dict(r))
    items.sort(key=lambda x: (x.get("sort_order") or 0, x.get("idx") or 0))
    return items


def _empty_config() -> dict:
    """Fallback apabila singleton belum wujud (sebelum install/migrate)."""
    hp = {
        "nav_cta": {"label": "Manage Booking", "url": "/traveller_portal"},
        "menu": [],
        "hero": {"tag": "", "title": "", "intro": "", "search_label": "", "stats": []},
        "featured": {"tag": "", "title": "", "subtitle": "", "cta_label": "", "cta_url": ""},
        "whyus": {"tag": "", "title": "", "subtitle": "", "benefits": []},
        "dest": {"tag": "", "title": "", "subtitle": ""},
        "testi": {"tag": "", "title": "", "subtitle": "", "testimonials": []},
        "cta": {
            "icon": "", "tag": "", "title": "", "body": "",
            "primary_label": "", "primary_url": "",
            "secondary_label": "", "secondary_url": "",
        },
    }
    return {
        "website_logo": "",
        "footer": {
            "tagline": "", "links": [], "columns": [],
            "support_email": "contact@rpwp.my",
            "copyright_text": "",
            "social": {},
        },
        "cruise": {**hp, "hero": {**hp["hero"], "search_label": "Search Cruises"}},
        "tour": {**hp, "hero": {**hp["hero"], "search_label": "Search Tours"}},
    }
