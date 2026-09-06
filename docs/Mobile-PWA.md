# Android app

Open **https://agents.arduano.io/** in Chrome on Android and sign in with
Cloudflare Access. In Chrome's menu choose **Install app** or **Add to Home
screen**. App settings also offers installation when Chrome makes it available.
The Tailscale HTTP IP still works as a website; installation, offline launch and
push require the HTTPS address. iPhone support and Android Share Target are
outside this release.

The phone opens to the agent list. **All, Needs you, Working, Finished and
Watched** filters, with counts, are available on both phone and desktop.
Attention and working agents appear first, followed by new results. Each row
shows an icon and status, recent activity, host, harness and workspace folder;
search also matches the full path and host name. Open a row for its conversation;
Back returns to the list.
Back also dismisses details, model settings, images and terminal dialogs first.
The composer respects the visible keyboard viewport and safe areas. Enter adds
a newline on touch devices; tap Send to submit. Gallery and Camera add images;
image previews open with zoom/pan. The terminal provides touch modifier/navigation
keys and retains its existing exclusive input-lease checks.

**Finished** means the latest observed native turn completed successfully.
**Ready** means idle without that evidence; **Interrupted**, **Stopped** and
**Offline** are separate states. Needs you includes pending questions, actionable
errors (including capacity limits), and interruptions. Offline agents retain
their place and watched setting but never count as working or finished.

**New** marks an unseen completion or attention event. Opening its conversation
in a visible window clears that event's marker; returning to the phone's agent
list does not acknowledge its hidden conversation. Review markers survive reload
and sync between tabs of the same browser. They remain local to each browser,
origin and owner, with at most 500 opaque session/event pairs and no messages.
Watching and reviewing are independent: opening an agent never enables push.

## Watched notifications

Open App settings, name the phone and choose **Enable notifications**. Permission
is requested only by this action. Use the bell in a conversation, or **Watch** in
the desktop header, to watch that
agent. Only explicitly watched agents send background notifications. Select
Finished, Needs input and Failed independently for this device. Notifications
contain an agent title and status, never transcript text or working paths. Use
**Send test notification**, lock the phone, and tap the resulting alert to open
the agent. Other devices can be revoked from settings.

The gateway observes accepted native completion, interaction and actionable-error
events through its existing source stream. It does not infer completion from
catalog idle, notify on child-thread completions as root completions, or blindly
retry/resume an agent. Automatic native retries suppress premature failure
notifications. Reconnect replay is baselined until the source's first accepted
heartbeat (normally about 15 seconds); events in this initial interval do not
notify. Notifications are best effort and may be delayed by Android or FCM.
Review the conversation for authoritative current state. New work or a resolved
question cancels obsolete queued alerts. Later alerts replace the same session's
OS notification; an already delivered notification cannot be remotely retracted.

For in-app status, the same observer retains only the latest small observation
for up to 500 sessions in an appended SQLite table. The authenticated
`GET /api/mobile/activity` endpoint supplies these observations, with exact native
binding fences. The foreground browser refreshes them every five seconds and
after catalog changes. It does not subscribe to every session's native output
or fetch background histories. Historical completions predating this observer,
and new events during initial replay baselining, do not create Finished/New
markers. Fresh snapshots and replay can retire obsolete progress or input hints.

Only Chrome/Android FCM subscriptions are accepted. VAPID keys, device
subscriptions, watches and a bounded delivery/deduplication ledger live privately
under the gateway state directory's `mobile/` folder. Back up this folder with
private gateway state to preserve device registration. Losing VAPID keys requires
re-enabling notifications on each phone. It is operational state, not a second
session catalog. Push settings are shared by the two authenticated gateway
listeners, while browser storage and subscriptions are origin-specific.

## Saved work and offline behavior

Text and image drafts save automatically in this browser's IndexedDB under an
opaque gateway/owner scope. They survive reload, suspension, host reconnect and
a cold offline launch. Offline launch shows saved drafts only. History is never
persisted offline and commands are never queued for automatic dispatch.
Drafts are local to this device, not synced between devices. Chrome/device data
cleanup can delete them; **Protect saved work** requests persistent storage.
The local-work budget is 256 MiB, with up to 50 MiB of images per draft, and the
normal model/image limits still apply when sending. Quota errors retain the
unsaved version in the current window and block dispatch. Concurrent-window
edits are preserved as separate conflict drafts rather than silently overwritten.

Exact launch, command and answer requests are saved before dispatch. If a reply
is lost, check the original host receipt in the conversation or App settings.
Any offered retry uses that original identity and request; a changed runtime
binding cannot silently replace it. Successful settlement consumes only matching
submitted draft content. Failed operations retain unsent work. Pending actions
must be resolved before clearing their local records.

An available app update waits for **Save and update**. Drafts flush before the
requesting window reloads. Authentication responses, native images, RPC traffic,
transcripts and mutations never enter service-worker caches; only a versioned
static shell does. Expired online authentication still follows Cloudflare Access.
Sign-out revokes this device's notification registration before leaving and keeps
its unsent local drafts. Delete saved drafts explicitly before sharing or clearing
the device.

## Verification

Automated qualification uses disposable API/WS fixtures, Chromium with Android
viewport/touch emulation, a real built service worker and real IndexedDB. It makes
no model calls and does not change production sessions. The existing transcript
layout and long-thread suites retain their original bounds, including the
200-message mounted window and the accepted memory-cache behavior.

A physical Android phone is still needed to confirm the OS install flow, camera
permission, keyboard behavior and delivery through FCM while the app is closed.
These device checks are separate from automated desktop-Chromium qualification.
