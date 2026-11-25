// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La feuille de style du site, servie a part (/site.css, mise en cache).
// Clair et sombre selon le systeme. Aucun script : la galerie, la note en
// etoiles et les filtres sont du CSS et des liens.
namespace SavoireStore.Site;

public static class SiteStyle
{
    public const string Css = """
        :root {
          color-scheme: light dark;
          --accent: #0d9488; --accent-strong: #0f766e; --accent-soft: #ccfbf1; --on-accent: #ffffff;
          --text: #0f172a; --muted: #64748b; --border: #e2e8f0; --bg: #f6f8fb; --surface: #ffffff; --surface-2: #f1f5f9;
          --shadow: 0 1px 2px rgb(15 23 42 / .05), 0 6px 20px rgb(15 23 42 / .06);
          --star: #f59e0b; --danger: #dc2626; --ok: #15803d; --radius: 14px;
        }
        @media (prefers-color-scheme: dark) {
          :root {
            --accent: #2dd4bf; --accent-strong: #5eead4; --accent-soft: #123f3b; --on-accent: #042f2e;
            --text: #e2e8f0; --muted: #94a3b8; --border: #1f2a40; --bg: #0b1120; --surface: #111a2d; --surface-2: #17223a;
            --shadow: 0 1px 2px rgb(0 0 0 / .35), 0 6px 20px rgb(0 0 0 / .25); --danger: #f87171; --ok: #4ade80;
          }
        }
        * { box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        body { margin: 0; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
        a { color: var(--accent-strong); text-decoration-thickness: 1px; text-underline-offset: 2px; }
        img { max-width: 100%; }
        h1, h2, h3, h4 { line-height: 1.25; margin: 0 0 .5em; }
        h2 { font-size: 21px; margin-top: 1.6em; }
        .wrap { max-width: 1160px; margin: 0 auto; padding: 0 20px; }
        .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
        .muted, .meta { color: var(--muted); }
        .meta { font-size: 13px; }

        /* En-tete */
        .top { position: sticky; top: 0; z-index: 20; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); }
        .top .wrap { display: flex; align-items: center; gap: 18px; min-height: 62px; flex-wrap: wrap; padding-top: 8px; padding-bottom: 8px; }
        .brand { display: flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; font-weight: 750; font-size: 17px; letter-spacing: -.01em; }
        .logo { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 16px;
                background: linear-gradient(135deg, #14b8a6, #0e7490); box-shadow: 0 2px 8px rgb(13 148 136 / .35); }
        .brand small { font-weight: 500; color: var(--muted); }
        .nav { display: flex; gap: 4px; }
        .nav a { color: var(--text); text-decoration: none; padding: 6px 10px; border-radius: 8px; font-weight: 550; font-size: 14px; }
        .nav a:hover, .nav a[aria-current] { background: var(--surface-2); }
        .top form.search { flex: 1 1 220px; max-width: 360px; margin-left: auto; }
        .top form.search input { width: 100%; padding: 8px 12px 8px 34px; border-radius: 10px; border: 1px solid var(--border); font: inherit; color: inherit; background: var(--surface) no-repeat 11px 50% / 15px 15px
                url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.4' stroke-linecap='round'%3E%3Ccircle cx='10.5' cy='10.5' r='6.5'/%3E%3Cpath d='m20 20-4.6-4.6'/%3E%3C/svg%3E"); }
        .account { display: flex; align-items: center; gap: 10px; font-size: 14px; }
        .account form { margin: 0; }

        /* Boutons et champs */
        .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 16px; border-radius: 10px; border: 1px solid var(--accent);
               background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 650; text-decoration: none; cursor: pointer; }
        .btn:hover { background: var(--accent-strong); border-color: var(--accent-strong); }
        .btn.ghost { background: transparent; color: var(--accent-strong); }
        .btn.ghost:hover { background: var(--accent-soft); }
        .btn.small { padding: 5px 11px; font-size: 13px; border-radius: 8px; }
        .btn.danger { background: transparent; border-color: var(--border); color: var(--danger); }
        .linkbtn { background: none; border: 0; padding: 0; font: inherit; color: var(--accent-strong); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
        input[type=search], input[type=text], textarea, select { font: inherit; color: inherit; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; }
        input:focus-visible, textarea:focus-visible, select:focus-visible, a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
        textarea { width: 100%; min-height: 110px; resize: vertical; }

        /* Bandeau d'accueil */
        .hero { padding: 64px 0 48px; text-align: center; border-bottom: 1px solid var(--border);
                background: radial-gradient(900px 300px at 50% -40px, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%); }
        .hero h1 { font-size: clamp(30px, 5vw, 46px); letter-spacing: -.025em; margin-bottom: 12px; }
        .hero p.lead { font-size: 18px; color: var(--muted); max-width: 640px; margin: 0 auto 26px; }
        .bigsearch { display: flex; max-width: 620px; margin: 0 auto; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 6px; box-shadow: var(--shadow); }
        .bigsearch input { flex: 1; border: 0; background: transparent; font-size: 17px; padding: 10px 14px; min-width: 0; }
        .bigsearch input:focus-visible { outline: none; }
        .bigsearch:focus-within { border-color: var(--accent); }
        .chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 22px; }
        .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 99px; border: 1px solid var(--border); background: var(--surface);
                color: var(--text); text-decoration: none; font-size: 14px; font-weight: 550; }
        .chip:hover { border-color: var(--accent); }
        .chip .n { color: var(--muted); font-weight: 500; font-size: 12px; }
        .chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-strong); }

        /* Sections */
        section.block { padding: 36px 0 8px; }
        .block-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
        .block-head h2 { margin: 0; }
        .block-head a { font-weight: 600; text-decoration: none; font-size: 14px; }

        /* Cartes */
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(255px, 1fr)); gap: 14px; }
        .card { display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
                color: inherit; text-decoration: none; transition: border-color .15s, transform .15s, box-shadow .15s; }
        .card:hover { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); transform: translateY(-2px); box-shadow: var(--shadow); }
        .card-head { display: flex; gap: 12px; align-items: center; }
        .card h3 { font-size: 16px; margin: 0; }
        .card .sum { margin: 0; color: var(--muted); font-size: 14px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 2.9em; }
        .card-foot { display: flex; align-items: center; gap: 12px; margin-top: auto; font-size: 13px; color: var(--muted); }
        .card-foot > span { white-space: nowrap; }
        .card-foot .kind { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .icon { flex: none; width: 46px; height: 46px; border-radius: 12px; object-fit: cover; background: var(--surface-2); }
        .icon.letter { display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 20px;
                       background: linear-gradient(135deg, hsl(var(--h) 60% 52%), hsl(calc(var(--h) + 40) 60% 40%)); }
        .icon.big { width: 92px; height: 92px; border-radius: 22px; font-size: 38px; }
        .tag { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 99px; background: var(--surface-2); color: var(--muted); text-decoration: none; }
        a.tag:hover { color: var(--accent-strong); }
        .price { font-weight: 650; color: var(--ok); }
        .stars { color: var(--star); letter-spacing: 1px; white-space: nowrap; }
        .stars .off { color: color-mix(in srgb, var(--muted) 40%, transparent); }

        /* Categories */
        .cats { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
        .cat { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--surface); color: inherit; text-decoration: none; }
        .cat:hover { border-color: var(--accent); }
        .cat .glyph { flex: none; width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; font-size: 18px; font-weight: 700;
                      color: hsl(var(--h) 65% 38%); background: hsl(var(--h) 70% 92%); }
        @media (prefers-color-scheme: dark) { .cat .glyph { color: hsl(var(--h) 70% 72%); background: hsl(var(--h) 45% 20%); } }
        .cat strong { display: block; }
        .cat span.d { font-size: 13px; color: var(--muted); }

        /* Catalogue */
        .page-head { padding: 28px 0 6px; }
        .page-head h1 { font-size: 30px; letter-spacing: -.02em; }
        .layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); gap: 30px; padding: 18px 0 60px; }
        @media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }
        .filters { align-self: start; position: sticky; top: 80px; }
        @media (max-width: 860px) { .filters { position: static; } }
        .filters h4 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 18px 0 6px; }
        .filters h4:first-child { margin-top: 0; }
        .facet { display: flex; justify-content: space-between; gap: 10px; padding: 5px 10px; border-radius: 8px; color: var(--text); text-decoration: none; font-size: 14px; }
        .facet:hover { background: var(--surface-2); }
        .facet.on { background: var(--accent-soft); color: var(--accent-strong); font-weight: 650; }
        .facet .n { color: var(--muted); font-size: 12px; }
        .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
        .toolbar form { display: flex; gap: 8px; flex: 1 1 280px; }
        .toolbar form input { flex: 1; }
        .seg { display: inline-flex; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--surface); }
        .seg a { padding: 6px 11px; font-size: 13px; color: var(--text); text-decoration: none; border-right: 1px solid var(--border); }
        .seg a:last-child { border-right: 0; }
        .seg a.on { background: var(--accent); color: var(--on-accent); font-weight: 650; }
        .active { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; align-items: center; }
        .active a { font-size: 13px; padding: 3px 10px; border-radius: 99px; background: var(--accent-soft); color: var(--accent-strong); text-decoration: none; }
        .active a::after { content: " ×"; font-weight: 700; }
        .empty { padding: 48px 20px; text-align: center; border: 1px dashed var(--border); border-radius: var(--radius); color: var(--muted); }
        .pager { display: flex; justify-content: center; align-items: center; gap: 6px; margin-top: 26px; }
        .pager a, .pager span { min-width: 36px; padding: 6px 10px; text-align: center; border-radius: 8px; border: 1px solid var(--border); text-decoration: none; color: var(--text); background: var(--surface); font-size: 14px; }
        .pager span.on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); font-weight: 650; }
        .pager span.gap { border: 0; background: none; }

        /* Fiche d'un element */
        .crumbs { font-size: 13px; color: var(--muted); padding-top: 22px; }
        .crumbs a { color: var(--muted); }
        .item-hero { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 22px; align-items: center; padding: 18px 0 22px; }
        @media (max-width: 760px) { .item-hero { grid-template-columns: auto 1fr; } .item-hero .cta { grid-column: 1 / -1; } }
        .item-hero h1 { font-size: clamp(26px, 4vw, 36px); letter-spacing: -.02em; margin-bottom: 4px; }
        .item-hero .lead { font-size: 17px; margin: 0 0 10px; }
        .facts { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 14px; color: var(--muted); align-items: center; }
        .facts b { color: var(--text); }
        .cta { display: flex; flex-direction: column; gap: 8px; align-items: stretch; min-width: 220px; }
        .cta .hint { font-size: 12px; color: var(--muted); text-align: center; max-width: 240px; }
        .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); overflow-x: auto; position: sticky; top: 62px; background: var(--bg); z-index: 5; }
        .tabs a { padding: 10px 14px; color: var(--muted); text-decoration: none; font-weight: 600; font-size: 14px; border-bottom: 2px solid transparent; white-space: nowrap; }
        .tabs a:hover { color: var(--text); border-bottom-color: var(--border); }
        .item-layout { display: grid; grid-template-columns: minmax(0, 1fr) 290px; gap: 36px; padding-bottom: 60px; }
        @media (max-width: 900px) { .item-layout { grid-template-columns: 1fr; } }
        .item-layout section { scroll-margin-top: 120px; }
        .panel { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 16px 18px; margin-top: 24px; }
        .panel h3 { font-size: 14px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: 10px; }
        dl.info { display: grid; grid-template-columns: auto 1fr; gap: 7px 14px; margin: 0; font-size: 14px; }
        dl.info dt { color: var(--muted); }
        dl.info dd { margin: 0; overflow-wrap: anywhere; }
        .prose { overflow-wrap: anywhere; }
        .prose pre { background: var(--surface-2); padding: 12px 14px; border-radius: 10px; overflow-x: auto; font-size: 13px; }
        .prose code { font-size: .92em; background: var(--surface-2); padding: 1px 5px; border-radius: 5px; }
        .prose pre code { background: none; padding: 0; }
        .prose blockquote { margin: 0; padding: 4px 16px; border-left: 3px solid var(--accent); color: var(--muted); }
        .prose .table { overflow-x: auto; }
        .prose table { border-collapse: collapse; width: 100%; font-size: 14px; margin: 10px 0; }
        .prose th, .prose td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
        .prose th { background: var(--surface-2); }
        ul.checks { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
        ul.checks li { display: flex; gap: 10px; align-items: baseline; padding: 8px 12px; border-radius: 10px; background: var(--surface); border: 1px solid var(--border); }
        ul.checks li::before { content: "•"; color: var(--accent); font-weight: 800; }
        .note { font-size: 13px; color: var(--muted); }
        table.versions { width: 100%; border-collapse: collapse; font-size: 14px; }
        table.versions th, table.versions td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
        table.versions th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }

        /* Galerie (sans script : liens vers des ancres, :target) */
        .gallery { display: flex; gap: 12px; overflow-x: auto; scroll-snap-type: x mandatory; padding: 4px 2px 14px; margin-top: 18px; }
        .shot { flex: 0 0 min(560px, 86%); scroll-snap-align: start; margin: 0; color: inherit; text-decoration: none; }
        .shot img { display: block; width: 100%; height: auto; aspect-ratio: 16 / 10; object-fit: cover; object-position: top; border-radius: 12px; border: 1px solid var(--border); background: var(--surface-2); }
        .shot span { display: block; font-size: 13px; color: var(--muted); margin-top: 6px; }
        .lightbox { display: none; position: fixed; inset: 0; z-index: 60; background: rgb(2 6 23 / .88); align-items: center; justify-content: center; padding: 24px; }
        .lightbox:target { display: flex; }
        .lightbox .close { position: absolute; inset: 0; }
        .lightbox figure { position: relative; margin: 0; max-width: 1200px; max-height: 100%; display: flex; flex-direction: column; align-items: center; gap: 10px; }
        .lightbox img { max-height: calc(100vh - 120px); width: auto; border-radius: 10px; box-shadow: 0 20px 60px rgb(0 0 0 / .5); }
        .lightbox figcaption { color: #e2e8f0; font-size: 14px; }
        .lightbox .lb-nav { position: relative; display: flex; gap: 10px; }
        .lightbox .lb-nav a { color: #fff; background: rgb(255 255 255 / .12); padding: 6px 14px; border-radius: 99px; text-decoration: none; font-size: 14px; }

        /* Avis */
        .rating-sum { display: grid; grid-template-columns: auto 1fr; gap: 28px; align-items: center; padding: 18px 20px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
        @media (max-width: 560px) { .rating-sum { grid-template-columns: 1fr; } }
        .rating-sum .big { font-size: 46px; font-weight: 800; line-height: 1; letter-spacing: -.03em; }
        .bars { display: grid; gap: 4px; }
        .bar { display: grid; grid-template-columns: 36px 1fr 34px; gap: 10px; align-items: center; font-size: 13px; color: var(--muted); }
        .bar .track { height: 8px; border-radius: 99px; background: var(--surface-2); overflow: hidden; }
        .bar .fill { height: 100%; background: var(--star); border-radius: 99px; }
        .review-form { margin-top: 16px; padding: 18px 20px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); display: grid; gap: 12px; }
        .review-form h3 { margin: 0; font-size: 16px; }
        .review-form .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .star-input { display: inline-flex; flex-direction: row-reverse; justify-content: flex-end; border: 0; padding: 0; margin: 0; }
        .star-input input { position: absolute; opacity: 0; width: 1px; height: 1px; }
        .star-input label { font-size: 30px; line-height: 1; padding: 0 2px; cursor: pointer; color: color-mix(in srgb, var(--muted) 45%, transparent); transition: color .1s, transform .1s; }
        .star-input input:checked ~ label, .star-input label:hover, .star-input label:hover ~ label { color: var(--star); }
        .star-input label:hover { transform: scale(1.12); }
        .star-input input:focus-visible + label { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
        .login-box { margin-top: 16px; padding: 16px 20px; border: 1px dashed var(--border); border-radius: var(--radius); display: flex; gap: 14px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
        .review { display: grid; grid-template-columns: 40px 1fr; gap: 12px; padding: 18px 0; border-bottom: 1px solid var(--border); }
        .review:last-child { border-bottom: 0; }
        .avatar { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; color: #fff; background: hsl(var(--h) 45% 50%); }
        .review .who { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
        .review p { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
        .review .mine { font-size: 12px; font-weight: 650; color: var(--accent-strong); }
        .reply { margin-top: 10px; padding: 10px 14px; border-radius: 10px; background: var(--surface-2); border-left: 3px solid var(--accent); }
        .reply .meta { font-weight: 600; }
        .review .actions { display: flex; gap: 14px; margin-top: 8px; font-size: 13px; align-items: center; }
        .review .actions form { margin: 0; }
        details.reply-form summary { cursor: pointer; color: var(--accent-strong); font-size: 13px; }
        details.reply-form form { display: grid; gap: 8px; margin-top: 8px; }

        /* Messages */
        .notice { margin: 16px 0 0; padding: 11px 14px; border-radius: 10px; font-size: 14px; border: 1px solid; }
        .notice.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, transparent); background: color-mix(in srgb, var(--ok) 9%, transparent); }
        .notice.err { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); background: color-mix(in srgb, var(--danger) 8%, transparent); }

        /* Petits ecrans : l'en-tete ne colle plus (il prendrait un tiers de l'ecran). */
        @media (max-width: 720px) {
          .top { position: static; }
          .tabs { top: 0; }
          .item-hero { align-items: start; gap: 16px; }
          .icon.big { width: 64px; height: 64px; font-size: 28px; border-radius: 16px; }
          .hero { padding: 40px 0 32px; }
        }

        /* Pied de page */
        footer { border-top: 1px solid var(--border); padding: 28px 0 40px; margin-top: 40px; color: var(--muted); font-size: 14px; }
        footer .wrap { display: flex; flex-wrap: wrap; gap: 10px 24px; justify-content: space-between; }
        footer nav { display: flex; gap: 18px; flex-wrap: wrap; }
        footer a { color: var(--muted); }
        """;
}
