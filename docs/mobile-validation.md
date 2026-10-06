# Mobile validation and beta gate

The audit's code and layout corrections are implemented. Automated JavaScript checks do not certify iOS behavior. The native tests and archive job must pass on a Mac, followed by the device checks below, before removing the beta gate.

## Build gate

Debug builds expose the shared interface and the existing fallback toggle. Ordinary Release builds use the original native interface. To produce a beta archive of the shared interface, add `LOCALFLOW_SHARED_UI` to `SWIFT_ACTIVE_COMPILATION_CONDITIONS`. CI sets this flag only for the unsigned beta archive, then verifies the manifest and asset hashes inside `Products/Applications/app.app/MobileWeb`.

The development test menu exists only in Debug with the launch argument `-mobileTestControls`. It can deliver a fixture through the production notification event handler and invoke the WebKit termination callback. UI tests use it to exercise route/draft rehydration; this is a simulated callback, not evidence that the OS killed a real WebKit process. The menu does not ship in beta Release archives.

## Tests and evidence

| Concern | Implemented check | Required external evidence |
|---|---|---|
| Blocked draft persistence | TS tests type after conflict, serialize delayed writes, reopen, and retry failed persistence. | Device suspension/termination during these operations. |
| Draft resolution | Native tests keep/discard, retain the unchosen version, reject stale decisions, replay transaction IDs, and retry disk failures. | Passing native XCTest result. |
| Migration | Native test loads an isolated legacy cache with hierarchy and unknown fields, saves the journal, and reopens without changing the retained caches. | A copy of a representative existing installation, including notification groups. |
| Concurrent sync | Injected native transport simulates extension writes, version conflicts, disjoint plan/note merges, and conflicting text across relaunch. | Two real clients against a test sync server, including task conflicts and server revision restore. |
| Native routes | Isolated route-state tests cover every starting tab, cold restoration, acknowledgment, and stale events. UI test delivers a fixture notification and simulates WebKit restart. | Real notification and `localflow://task/<id>` entry on cold/warm launches, including missing/deleted tasks. |
| Cross-language rules | Shared fixtures now cover hierarchy, blockers, completion, recurrence/date offsets, occurrence snapshots, independent deletion, and restoration. | Passing Swift fixture tests alongside the passing TypeScript tests. |
| Dates | JS tests cover the 8 a.m. boundary on spring/fall daylight-saving days, midnight, and a timezone change at the same instant. | Change the phone timezone while the app is foregrounded/suspended and verify Plan and reminder behavior. |
| Wide layouts | Tasks preserves the dashboard beside its workspace at 760px and above; Notes preserves its folder list beside the editor. The iPad UI workflow checks that quick-add remains hittable with a workspace open. | Portrait, landscape, split view, and keyboard review on iPad. |
| Theme and focus | Shared tokens are consumed by both hosts; native palette mappings and semantic text contrast are checked by `npm run verify:theme`. Recovery/review use native HTML dialogs. | VoiceOver, switch/keyboard navigation, focus return, large text, and selected-state contrast on actual screens. |
| Packaging | CI builds an unsigned iOS beta archive and verifies its actual bundled assets. | Successful CI archive and XCTest artifacts, then signed-device installation. |

## Shared visual specification

`packages/ui/src/tokens.scss` is the web source for light/dark semantic colors, system font, spacing, and touch size. The extracted task, note, and plan styles consume it in the extension as well as mobile. Native mapping lives in `LocalFlowTheme.swift` and the AccentColor asset.

| Token / semantic role | Native mapping |
|---|---|
| Background, surface, primary text, secondary text | Dynamic light/dark colors in `LocalFlowTheme`; verified against the token file. |
| Accent | AccentColor light `#365f46`, dark `#9fc7aa`. |
| Body / caption typography | SwiftUI semantic `.body` / `.caption`; web system font, 16px body / 13px caption. Native fonts scale with Dynamic Type. |
| Spacing | 4, 8, 12, 16, 20, 24 units; Alerts uses 12-point row padding and 16-point horizontal insets. |
| Touch target | 44 points native and 44 CSS pixels in mobile controls. |
| Surface radius | 16 units, with native system list grouping retained. |

The contrast verifier checks semantic text pairs at a minimum ratio of 4.5 in each theme. It cannot establish contrast for every rendered state, graphs, disabled controls, or text over content. Those require screen review.

## Performance sessions

Use the preview's isolated sample datasets to make sessions repeatable:

```text
http://127.0.0.1:8093/?preview=1&dataset=small    (50 tasks)
http://127.0.0.1:8093/?preview=1&dataset=medium   (500 tasks)
http://127.0.0.1:8093/?preview=1&dataset=large    (2,500 tasks)
```

Each dataset has its own preview storage. It never writes to native or synced data. For installed-app profiling, import equivalent data into a separate test store and use the same archive and device for comparisons. Native snapshot notifications are now coalesced per main-loop turn to avoid repeatedly encoding the same mutation.

The following are **provisional acceptance targets, not measurements**. Record the device/OS, dataset, build configuration, 20 samples, and p50/p95 for each interaction using Instruments and Web Inspector:

| Measurement | Proposed p95 target |
|---|---|
| Cold launch to usable Tasks, small/medium data | 2 seconds |
| Cold launch to usable Tasks, large data | 4 seconds |
| Input-to-painted character during note/plan editing | 100 ms |
| Task selection to visible workspace, small/medium | 200 ms |
| Task selection to visible workspace, large | 500 ms |
| Sustained list/map scrolling | 55 fps or better on a 60 Hz device |
| Ten tab/workspace cycles | No monotonic retained-memory growth after settling |

Profile a physical baseline iPhone and an iPad in Release-with-beta-flag configuration, both offline and while syncing. Include rapid typing during a remote conflict and the largest expanded branch. If the targets fail, narrow/virtualize expensive views based on the trace, then repeat the same samples. No physical-device numbers have been collected in this Windows workspace.

## Acceptance record

Still pending: Mac/Xcode compilation and test execution, signed installation, real OS process termination, browser/device visual sessions, VoiceOver and large-text testing, physical performance measurements, and staged beta feedback. Do not mark these complete based on source inspection or the existence of a CI job.
