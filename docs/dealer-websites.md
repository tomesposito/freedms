# Dealer websites v1

Public pages render directly from the tenant's current available inventory:

- `/public/{tenantId}/site/` — home, search, featured vehicles, store information.
- `/public/{tenantId}/site/inventory` — keyword/make/under-$20k filters and ascending price sort, using query parameters `q`, `make`, `under=20000`, and `sort=price`.
- `/public/{tenantId}/site/vehicles/{vehicleId}` — photos, public specifications, price, inquiry form. Sold, unavailable, unknown, and other tenants' vehicles return 404.
- `/public/{tenantId}/site/about` — about text, store photo, store information.
- `/public/{tenantId}/site/contact` — store information and general inquiry form.

Every page includes schema.org inventory JSON-LD and links the tenant's existing
`llms.txt` index. Public reads do not write records or call authenticated app
routes. Reads use the same tenant resolution locally and when hosted. Hosted
deployment requires the `/public/*` CloudFront API behavior and the explicit
anonymous API Gateway routes in `infra/template.yaml`; see DEPLOYMENT.md.

Admins edit the eight identity/appearance controls in Deals → Workspace settings
→ Website (`GET/PUT /settings/website`). The versioned `website-settings` CRM
record uses existing tenant storage and atomic outbox events. Store name, phone,
and address default to the tenant profile. Blank identity overrides use those
profile values. Unset hours invite shoppers to call; unset about text has a short
welcome. Color defaults to #ff6a00. There is one fixed layout and no custom HTML.

Inventory records now accept optional `photoUrls` (up to 20 HTTP(S) URLs), editable
in Add/Edit vehicle. Earlier inventory had no photo URL field. Updates from older
clients preserve existing photos; an explicit empty array clears them. Public
pages use the first photo as the cover, with additional detail-page images. Zero
photos show a gradient placeholder. Internal notes, costs, recon, and location
never appear publicly.

Vehicle and contact forms POST URL-encoded name, phone/email, and message to their
own public URL. The server resolves the tenant and vehicle from that URL and
calls the existing CRM `createLead` intake core: customer validation, references,
atomic customer/lead/outbox writes, and normal webhook scheduling. No intake token
is needed or exposed. The message becomes customer notes; the vehicle is attached
to vehicle-page leads, and contact-page leads have no vehicle. Validation errors
render on the form and success is explicit. Inquiries do not grant marketing
consent. The per-process fixed-window limit is 120 reads and 10 submissions per
source IP and tenant per minute; instances do not share buckets.

The pages use the approved mockup's CSS and fixed layout, with accessible mobile
navigation. Copy does not invent inspection, financing, fee, or response-time
promises the inventory model cannot establish. Only known vehicle specifications
are shown. Images are dealer-supplied URLs; no fonts, scripts, framework, or other
external assets are loaded.

## Local verification

Run `npm test` and `npm run build`. The full suite is offline. Its loopback-server
tests require permission to bind local sockets. `npm run dev` serves the API on
3001 and the app on 5173; Vite proxies `/public` to the API as well as `/api`.
The local API starts empty; seed a tenant through `/local/session` and create
inventory through the authenticated API before browsing its public site.

The six `docs/screenshots/dealer-site-*.png` captures came from the actual local
API with a seeded Demo Motors tenant, six available vehicles, and zero photos.
The browser tour checked all five pages at 1440px and 390px, absence of horizontal
overflow, JSON-LD, native vehicle/contact form success, and the resulting CRM
leads. It also saved Website settings and vehicle photo URLs through the real
authenticated web UI. The images are real app captures, not the approved staged
mockup.

Validation: `npm test` passed all 747 tests (0 failures, 0 skipped); `npm run
build` passed its full TypeScript check and shared/API/web builds. Vite reports
the existing large app-bundle warning; public pages do not load that bundle.

Persona impact: P1 Owner-Operator can configure the few controls and receive site
leads; P14 Public Shopper can browse and inquire. This completes #151–#153 and
makes J15's existing discovery → dealer site → dealer lead steps live. No persona
files or journey steps were changed. Custom domains, host routing, cross-dealer
search, additional themes, service/parts pages, feeds of reviews, and language
toggles remain outside this slice. All work is local; no push, AWS, or deployment.
