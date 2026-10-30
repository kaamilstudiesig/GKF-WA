# CRM UI guide

How the staff CRM looks and behaves, and the rules for adding screens. Most staff use it **on a phone, between calls**, so mobile comes first.

## Built on a design system, not custom CSS

- **[daisyUI 5](https://daisyui.com/) on [Tailwind CSS 4](https://tailwindcss.com/)**, pinned versions in `package.json`. daisyUI is pure CSS classes, so it works with our server-rendered EJS pages (no React). We use its components (dock, navbar, drawer, list, chat bubbles, modal bottom sheets, tabs, badges, stats, tables, forms) and only theme them.
- Source: `crm/styles/app.css` (theme + a few component tweaks). Build: `npm run build:css` → `crm/public/css/app.css` (git-ignored; Heroku builds it in `heroku-postbuild`, `npm run dev` builds it first).
- Theme `gkf`: near-black surfaces, GKF gold as the primary colour, Inter for all text, Bebas Neue only for page titles and the logo. **No all-caps buttons or labels**: sentence case reads faster.
- Icons: [Lucide](https://lucide.dev/) (ISC licence), inlined via `crm/views/partials/icon.ejs`.

## What we copied from leading CRMs

| Pattern | Seen in | Our version |
| --- | --- | --- |
| Bottom tab bar on phones, 3-5 items, thumb reach | iOS/Android conventions, mobile CRM guides | daisyUI **dock**: Home · Leads · Follow-ups · Pipeline · More. Sidebar on desktop. |
| Record header with name, status and quick action icons | HubSpot record highlight (note, email, call…), Pipedrive deal header | Lead header: name, number, status + "needs human" badges, **Call · WhatsApp · Log outcome** |
| Log activity from a "+" / one-click trigger | Pipedrive "+" in activities, HubSpot log icons | **Log outcome** opens a bottom sheet with large tiles (2 per row), extra fields only for Visit booked / Joined / Lost |
| Lead card = the conversation | Kommo WhatsApp lead card, WhatsApp itself | Chat styled like WhatsApp dark mode (wallpaper, grey/green bubbles with time inside, date chips, round send button). On phones the **page** scrolls (no scroll box inside a page) and the message box sticks to the bottom; the top bar is WhatsApp-like (back, avatar, name/status, call, Log) |
| Tabs for record sections | HubSpot About / Activities | Tabs: **Chat · Details · Notes & tasks · History** (two columns on desktop) |
| Colour-coded task urgency | Kommo (green today, red overdue) | Follow-ups: red overdue, amber due today |
| List rows, not tables, on phones | All mobile CRMs | Leads as list rows (initials, name, last message, time, status); table from `lg` up |
| Quick filters as chips | Mobile inbox apps | Chips: All · Needs human · Hot · New · Mine; full filters in a bottom sheet |

## Rules for new screens

1. Design at **375px wide first**, then add `lg:` layouts. No horizontal scrolling except inside tables.
2. Touch targets at least **44px** high (`btn` default size is fine; avoid `btn-xs` for actions).
3. One **primary** action per screen (`btn-primary`, gold). Everything else `btn-ghost` / `btn-outline`.
4. Use daisyUI components before writing CSS. If you must, add it to `crm/styles/app.css` with a comment.
5. Status colours come from `partials/status.ejs`; don't invent new ones per page.
6. Forms keep their field `name`s and routes when restyled; tests and the server rely on them.
7. Check every changed screen in the browser at phone (375px) and desktop width before opening a PR.
8. Keep `id="outcome"` on the lead page's outcome sheet: Telegram's "Log outcome" button links to it.
9. No scroll areas inside the page on phones (they trap the thumb); let the page scroll.
10. CSS/JS links carry `?v=<hash>` (`app.locals.assetV`) so phones load new files after each deploy. Keep it on any new asset link.
11. Custom CSS that must beat daisyUI component styles goes **outside** `@layer` in `crm/styles/app.css` (daisyUI's layer wins over ours otherwise).

Sources: [mobile navigation patterns](https://www.designstudiouiux.com/blog/mobile-navigation-ux/), [CRM UX practices](https://www.designstudiouiux.com/blog/crm-ux-design-best-practices/), [HubSpot record layout](https://knowledge.hubspot.com/records/understand-the-default-record-layout), [Pipedrive deal detail view](https://support.pipedrive.com/en/article/deal-detail-view), [Kommo WhatsApp for teams](https://www.kommo.com/whatsapp/whatsapp-for-teams/).
