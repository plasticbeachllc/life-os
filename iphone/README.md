# LifeOS for iPhone

This directory contains a native SwiftUI prototype for the LifeOS mobile client. The current app is
intentionally read-only and uses fabricated preview data. It does not connect to SQLite, the Obsidian
vault, provider APIs, MCP, or any mutation workflow.

## Run it

1. Install the current release of Xcode from Apple.
2. Open `LifeOS.xcodeproj`.
3. Select an iPhone simulator and press Run.

The target supports iOS 17 and later. No developer-team selection is needed for the simulator; Xcode
will ask for a team if you later run on a physical device.

## Structure

- `LifeOS/AppModel.swift` owns prototype UI state.
- `LifeOS/Models.swift` defines the sanitized mobile projections.
- `LifeOS/PreviewData.swift` contains fabricated local data.
- `LifeOS/Views/` contains the Today, Inbox, Tasks, and More tabs.
- `LifeOS/Views/TaskDetailView.swift` separates vault-derived context from optional agent commentary.
- `LifeOS/Components/` contains small reusable SwiftUI views.

The eventual connected app should consume narrow, sanitized JSON endpoints. It must not receive raw
provider content, arbitrary paths or SQL, direct SQLite access, or mutation capabilities that bypass
LifeOS prepare/review/confirm and hash checks.
