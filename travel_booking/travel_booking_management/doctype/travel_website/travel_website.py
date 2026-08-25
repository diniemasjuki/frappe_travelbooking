# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TravelWebsite(Document):
    # begin: auto-generated types
    # This code is auto-generated. Do not modify anything in this block.

    from typing import TYPE_CHECKING

    if TYPE_CHECKING:
        from frappe.types import DF
        from travel_booking.travel_booking_management.doctype.website_benefit_card.website_benefit_card import WebsiteBenefitCard
        from travel_booking.travel_booking_management.doctype.website_footer_link.website_footer_link import WebsiteFooterLink
        from travel_booking.travel_booking_management.doctype.website_menu_item.website_menu_item import WebsiteMenuItem
        from travel_booking.travel_booking_management.doctype.website_stat.website_stat import WebsiteStat
        from travel_booking.travel_booking_management.doctype.website_testimonial.website_testimonial import WebsiteTestimonial

        copyright_text: DF.Data | None
        cruise_benefits: DF.Table[WebsiteBenefitCard]
        cruise_cta_body: DF.SmallText | None
        cruise_cta_icon: DF.Data | None
        cruise_cta_primary_label: DF.Data | None
        cruise_cta_primary_url: DF.Data | None
        cruise_cta_secondary_label: DF.Data | None
        cruise_cta_secondary_url: DF.Data | None
        cruise_cta_tag: DF.Data | None
        cruise_cta_title: DF.Data | None
        cruise_dest_subtitle: DF.SmallText | None
        cruise_dest_tag: DF.Data | None
        cruise_dest_title: DF.SmallText | None
        cruise_featured_cta_label: DF.Data | None
        cruise_featured_cta_url: DF.Data | None
        cruise_featured_subtitle: DF.SmallText | None
        cruise_featured_tag: DF.Data | None
        cruise_featured_title: DF.SmallText | None
        cruise_hero_background: DF.AttachImage | None
        cruise_hero_intro: DF.SmallText | None
        cruise_hero_search_label: DF.Data | None
        cruise_hero_stats: DF.Table[WebsiteStat]
        cruise_hero_tag: DF.Data | None
        cruise_hero_title: DF.SmallText | None
        cruise_logo: DF.AttachImage | None
        cruise_menu: DF.Table[WebsiteMenuItem]
        cruise_nav_cta_label: DF.Data | None
        cruise_nav_cta_url: DF.Data | None
        cruise_testi_subtitle: DF.SmallText | None
        cruise_testi_tag: DF.Data | None
        cruise_testi_title: DF.SmallText | None
        cruise_testimonials: DF.Table[WebsiteTestimonial]
        cruise_whyus_subtitle: DF.SmallText | None
        cruise_whyus_tag: DF.Data | None
        cruise_whyus_title: DF.SmallText | None
        footer_links: DF.Table[WebsiteFooterLink]
        footer_tagline: DF.TextEditor | None
        social_facebook: DF.Data | None
        social_instagram: DF.Data | None
        social_whatsapp: DF.Data | None
        support_email: DF.Data | None
        tour_benefits: DF.Table[WebsiteBenefitCard]
        tour_cta_body: DF.TextEditor | None
        tour_cta_icon: DF.Data | None
        tour_cta_primary_label: DF.Data | None
        tour_cta_primary_url: DF.Data | None
        tour_cta_secondary_label: DF.Data | None
        tour_cta_secondary_url: DF.Data | None
        tour_cta_tag: DF.Data | None
        tour_cta_title: DF.Data | None
        tour_dest_subtitle: DF.SmallText | None
        tour_dest_tag: DF.Data | None
        tour_dest_title: DF.SmallText | None
        tour_featured_cta_label: DF.Data | None
        tour_featured_cta_url: DF.Data | None
        tour_featured_subtitle: DF.SmallText | None
        tour_featured_tag: DF.Data | None
        tour_featured_title: DF.SmallText | None
        tour_hero_background: DF.AttachImage | None
        tour_hero_intro: DF.SmallText | None
        tour_hero_search_label: DF.Data | None
        tour_hero_stats: DF.Table[WebsiteStat]
        tour_hero_tag: DF.Data | None
        tour_hero_title: DF.SmallText | None
        tour_logo: DF.AttachImage | None
        tour_menu: DF.Table[WebsiteMenuItem]
        tour_nav_cta_label: DF.Data | None
        tour_nav_cta_url: DF.Data | None
        tour_testi_subtitle: DF.SmallText | None
        tour_testi_tag: DF.Data | None
        tour_testi_title: DF.SmallText | None
        tour_testimonials: DF.Table[WebsiteTestimonial]
        tour_whyus_subtitle: DF.SmallText | None
        tour_whyus_tag: DF.Data | None
        tour_whyus_title: DF.SmallText | None
    # end: auto-generated types

    def on_update(self):
        # Kosongkan cache konfigurasi supaya perubahan di Desk dipaparkan
        # serta-merta pada homepage awam dan Trip Command Center.
        cache = frappe.cache()
        # Template rendering cache (used by website_config.py)
        cache.delete_value("travel_website_config")
        # Trip Command Center desk page cache
        cache.delete_value("tcc_website_settings")
