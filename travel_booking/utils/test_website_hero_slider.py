# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk hero slider homepage /cruise — Travel Website →
Cruise Homepage → Hero Slider (child Website Banner Slide).

Dua lapisan:
  1. website_config._homepage_block — baris slide (aktif, ikut sort_order)
     + Default Button Label.
  2. Markup carousel dalam www/cruise.html — blok carousel dirender
     terus daripada sumber template dengan sample slides (tanpa DB/HTTP).
"""

import re
from pathlib import Path

import frappe
import jinja2
from frappe.tests import UnitTestCase

from travel_booking.utils.website_config import _empty_config, _homepage_block

CRUISE_HTML = Path(frappe.get_app_path("travel_booking")) / "www" / "cruise.html"


def _render_carousel(hero_slides, hero):
	"""Render blok carousel hero daripada cruise.html seadanya.

	`hero` = dict blok `hero` (banners/tag/title/intro/slide_cta_label) —
	sama bentuk dengan wc.cruise.hero yang diterima template.
	"""
	source = CRUISE_HTML.read_text(encoding="utf-8")
	match = re.search(
		r"\{% set slides = hero_slides or \[\] %\}.*?"
		r'<section class="carousel slide carousel-fade rc-hero-slider".*?</section>',
		source,
		re.S,
	)
	if not match:
		raise AssertionError("blok carousel hero tidak dijumpai dalam www/cruise.html")

	template = jinja2.Environment(autoescape=True).from_string(match.group(0))
	return template.render(hero_slides=hero_slides, hp={"hero": hero})


def _slides(html):
	"""Pecahkan markup carousel → list dict per slide."""
	out = []
	chunks = html.split('<div class="carousel-item rc-slide')[1:]
	for chunk in chunks:
		def pick(pattern):
			m = re.search(pattern, chunk, re.S)
			return m.group(1).strip() if m else ""

		out.append(
			frappe._dict(
				image=pick(r"background-image:url\('([^']*)'\)"),
				tag=pick(r'<span class="rc-hero-tag">(.*?)</span>'),
				title=pick(r"<h1>(.*?)</h1>"),
				intro=pick(r'<div class="rc-hero-intro">(.*?)</div>'),
				cta_label=pick(r'<a href="[^"]*" class="btn btn-primary btn-lg rc-slide-cta">\s*(.*?)\s*<i'),
				cta_href=pick(r'<a href="([^"]*)" class="btn btn-primary btn-lg rc-slide-cta">'),
			)
		)
	return out


class WebsiteHeroSliderTestCase(UnitTestCase):
	def test_homepage_block_passes_slide_fields_sorted(self):
		doc = frappe._dict(
			cruise_banners=[
				frappe._dict(is_active=1, sort_order=20, banner_title="Second", banner_cta_label="Deals"),
				frappe._dict(is_active=0, sort_order=5, banner_title="Hidden"),
				frappe._dict(is_active=1, sort_order=10, banner_title="First", banner_cta_label=""),
			],
			cruise_slide_cta_label="Explore",
		)
		hero = _homepage_block(doc, "cruise")["hero"]
		# Aktif sahaja, ikut sort_order; Button Label per slide dibawa bersama.
		self.assertEqual([s["banner_title"] for s in hero["banners"]], ["First", "Second"])
		self.assertEqual([s["banner_cta_label"] for s in hero["banners"]], ["", "Deals"])
		self.assertEqual(hero["slide_cta_label"], "Explore")

	def test_empty_config_has_slider_keys(self):
		hero = _empty_config()["cruise"]["hero"]
		self.assertEqual(hero["banners"], [])
		self.assertEqual(hero["slide_cta_label"], "Explore")

	def test_slide_button_uses_own_label_then_default(self):
		slides = [
			{"banner_image": "/files/a.jpg", "banner_link_url": "/cruises", "banner_cta_label": "View Cruises"},
			{"banner_image": "/files/b.jpg", "banner_link_url": "/cruise-schedule"},
			{"banner_image": "/files/c.jpg"},
		]
		out = _slides(_render_carousel(slides, {"banners": slides, "slide_cta_label": "Discover"}))

		# Label sendiri > Default Button Label > 'Explore'
		self.assertEqual([s["cta_label"] for s in out], ["View Cruises", "Discover", ""])
		self.assertEqual(out[0]["cta_href"], "/cruises")
		# Tiada Button URL → tiada butang pada slide itu.
		self.assertEqual(out[2]["cta_href"], "")

	def test_slide_without_own_label_falls_back_to_explore(self):
		slides = [{"banner_image": "/files/a.jpg", "banner_link_url": "/cruises"}]
		out = _slides(_render_carousel(slides, {"banners": slides, "slide_cta_label": ""}))
		self.assertEqual(out[0]["cta_label"], "Explore")

	def test_configured_slide_does_not_inherit_global_caption(self):
		# Slide pertama yang captionnya sengaja kosong kekal kosong — caption
		# global (Fallback Banner) tidak diwarisi.
		slides = [{"banner_image": "/files/a.jpg", "banner_title": ""}]
		out = _slides(
			_render_carousel(
				slides,
				{"banners": slides, "tag": "GLOBAL TAG", "title": "GLOBAL TITLE", "intro": "GLOBAL INTRO"},
			)
		)
		self.assertEqual((out[0]["tag"], out[0]["title"], out[0]["intro"]), ("", "", ""))

	def test_slide_caption_html_is_kept(self):
		slides = [{"banner_image": "/files/a.jpg", "banner_tag": "Season", "banner_title": "Sail the <em>Med</em>"}]
		out = _slides(_render_carousel(slides, {"banners": slides}))
		self.assertEqual(out[0]["title"], "Sail the <em>Med</em>")
		self.assertEqual(out[0]["tag"], "Season")

	def test_fallback_banner_uses_global_background_and_caption(self):
		# Tiada slide dikonfigurasi → cruise.py hantar satu slide fallback
		# (imej = hero background, caption kosong) dan template isi caption
		# daripada Fallback Banner.
		fallback = [
			{
				"banner_image": "/files/hero.jpg",
				"banner_tag": "",
				"banner_title": "",
				"banner_subtitle": "",
				"banner_cta_label": "",
				"banner_link_url": "",
			}
		]
		out = _slides(
			_render_carousel(
				fallback,
				{"banners": [], "tag": "Set Sail", "title": "Perfect <em>Cruise</em>", "intro": "Intro text"},
			)
		)
		self.assertEqual(len(out), 1)
		self.assertEqual(out[0].image, "/files/hero.jpg")
		self.assertEqual(out[0].tag, "Set Sail")
		self.assertEqual(out[0].title, "Perfect <em>Cruise</em>")
		self.assertEqual(out[0].intro, "Intro text")
