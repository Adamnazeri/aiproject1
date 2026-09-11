# Apa yang berubah

1. **Login / Signup** — `backend/app.py` ada endpoint baru:
   - `POST /api/auth/signup` — { name, email, password }
   - `POST /api/auth/login` — { email, password }
   - `POST /api/subscribe` — { plan: "free" | "pro" } (mock payment, perlu login)
   Password di-hash guna PBKDF2 (tiada dependency baru). Token login guna HMAC signed token — simple, tak perlu install JWT library.

2. **Design** — `frontend/style.css` full redesign: light corporate theme (navy + biru + teal), tiada warna hitam. Ada animation (fade-in, hover lift, transition pada button/card/modal).

3. **UI baru** — `frontend/index.html`:
   - Topbar ada butang Log in / Sign up (bertukar jadi nama + plan badge bila dah login)
   - Modal login/signup
   - Section "Plans" (Free vs Pro) dengan butang subscribe (mock checkout)

4. **script.js** — logic auth (simpan token dalam localStorage), subscribe/upgrade plan, semua feature asal (scan, resume builder, chat assistant) kekal jalan macam biasa.

# Cara pasang

1. **Ganti file-file ni** dalam projek awak (`aiproject1/`):
   - `backend/app.py`
   - `database/schema.sql`
   - `frontend/index.html`
   - `frontend/style.css`
   - `frontend/script.js`

2. **Tambah SECRET_KEY dalam `.env`** (untuk sign token login):
   ```
   SECRET_KEY=letak-random-string-panjang-di-sini
   ```
   Boleh generate dengan: `python -c "import secrets; print(secrets.token_hex(32))"`

3. **Database sedia ada (`database/app.db`)** — awak TAK perlu delete/reset. `app.py` akan auto-tambah column `plan` dan `plan_started_at` pada table `users` bila server start (migration automatik, data lama selamat).

4. **Restart server**:
   ```
   uvicorn backend.app:app --reload --port 5000
   ```

# Notes

- Payment sekarang **mock/dummy** — bila user klik "Upgrade to Pro", terus set plan jadi "pro" dalam DB, tiada gateway sebenar. Nanti nak connect Stripe, cuma ganti isi function `subscribe()` dalam `app.py` — frontend contract (POST plan → plan update) boleh kekal sama.
- Guest (tak login) masih boleh scan resume macam biasa — resume akan simpan bawah user_id=1 sebagai fallback.
## Update — Motion & animation polish (this round)

No layout, functionality, forms, database logic, or backend routes were touched.
`app.py` and `schema.sql` are unchanged from before — only `frontend/style.css`,
`frontend/script.js`, and `frontend/index.html` were edited, and only for motion.

What was added, all with CSS transitions/keyframes + `IntersectionObserver`
(no animation library):

- **Scroll reveal** — sections fade+slide up once when they enter view; heading →
  description → form stagger on the builder/hero sections at load.
- **Navbar** — subtle shadow fades in once you scroll past the top.
- **Inputs** — smoother hover/focus glow; invalid fields get a small horizontal
  nudge instead of nothing.
- **Buttons** — consistent hover-lift + press-down feedback across primary/secondary/nav buttons.
- **Template cards** — 1.02 hover scale, animated selected-state border.
- **Photo upload** — fade+scale in on upload, fade+scale out on remove.
- **Add/remove experience & education** — rows animate in, and animate out
  before being removed from the DOM (removal logic itself is unchanged).
- **Scan / generate / file upload** — skeleton placeholder cards + a small
  rotating "Analyzing resume... / Matching skills... / ..." indicator while
  waiting, then a checkmark on success.
- **Chat assistant** — animated "Thinking" dots while waiting for a reply.
- Everything respects `prefers-reduced-motion` and uses only `transform`/`opacity`
  for the scroll/hover work, so it stays cheap on mobile.

