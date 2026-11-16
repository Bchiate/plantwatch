# Changelog

Dates are when the work was committed. Version numbers are the iOS app's.

Entries before the public release describe the private working version. The public version leaves out the admin dashboard and guest sharing.

## 2026-11-15

- Ported the Ecowitt retries from the private version. A request that fails in a way that can clear on its own (a dropped connection, a 5xx or 429, an unreadable body, Ecowitt's busy codes) is tried up to three times. Rejected keys, unknown gateways and timeouts are not retried.
- Ported the limit on last-seen lookups. A gateway whose sensors are all quiet gets one history lookup that answers for all of them, and individual dropouts are capped at six lookups per gateway, so a hub outage no longer means dozens of slow calls.

## Public release (2026-10-06)

- Cleaned-up public version of the private working repo: restructured layout, tests, CI, a demo mode and documentation. It left out the Ecowitt retries and the limit on last-seen lookups, which came back on 2026-11-15.

## 2026-08-27

- Admin dashboard, species catalog and sensor management. Onboarding hardened.
- Read-only garden sharing for guests.
- Report reliability: retry transient Ecowitt API failures and bound the last-seen lookups.

## 2026-08-18

- Security: the plant-report function requires a verified JWT.

## 2.1 (2026-05-30)

- Full in-app onboarding on iOS.

## 2.0 (2026-05-30)

- Multi-tenant foundation: sign-in, per-user data and authenticated functions.
- Web sign-in, with the dashboard wired to the new per-user report.
- iOS sign-in and a per-user authenticated app.

## 1.08 to 1.15 (2026-05-30)

- Front-yard gateway, and handling for sensors that aren't assigned to a plant yet.
- Per-plant zone picker. Drag to reorder plants within and across sections.
- Sensor-dropout diagnosis. Offline sensors show when they were last seen, and a notification goes out when one drops.
- Editable plant names.

## 1.05 to 1.07 (2026-05-27)

- Moisture ranges tuned against horticulture guidance.
- Per-plant range overrides and notifications.
- Adaptive grid for iPhone.

## 1.02 to 1.04 (2026-05-26)

- Yard zones with a filter, a layout toggle, and an info popover for every plant.
- Channel map with source citations and a 60-second refresh.

## Initial release (2026-05-25)

- Live soil-moisture readings mapped to plants, with weather in °F and inches.
- Research-backed plant profiles and forecast-aware advice.
