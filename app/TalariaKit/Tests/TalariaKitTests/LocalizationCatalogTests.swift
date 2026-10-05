import XCTest

/// Guards the App Localization effort (issues #290, #291, …): every translatable key must
/// carry a non-empty value in **each shipped language** unless it is explicitly staged.
///
/// The catalog is JSON on disk; we read the source file directly (located relative to
/// this test via `#filePath`) so the guard runs without bundling the catalog into the
/// test target. Keys explicitly marked `"shouldTranslate": false` (brand names,
/// format-only artifacts) are intentionally skipped.
///
/// Language declarations in the project and both catalogs must match `shippedLanguages`.
final class LocalizationCatalogTests: XCTestCase {

    /// Non-English languages compiled into the app. Keep in sync with `knownRegions` in the
    /// project file and the languages present in `Localizable.xcstrings`.
    private static let shippedLanguages = ["de", "es", "fr", "it", "pl", "pt-BR", "nl", "tr", "ru", "ja", "zh-Hans", "ko", "ar", "he", "ur", "zh-Hant", "zh-HK"]

    /// Source-only keys present when completeness enforcement was introduced. Removing an
    /// entry requires either translating it or marking it `shouldTranslate: false` in the catalog.
    private static let intentionallyStagedKeys: Set<String> = [
        "  %lld",
        "  −%lld",
        "%@ percent",
        "%@ of %@",
        "%@",
        "%lld active sessions",
        "%lld changes",
        "+%lld",
        ", ",
        "/",
        "1 active session",
        "1 change",
        "About",
        "Age %@",
        "Agent status",
        "Agent work failed",
        "Another SSO sign-in is already in progress.",
        "Alerts & Haptics",
        "All Devices",
        "All Profiles",
        "All Tenants",
        "All changes",
        "Allow Photos access to save media from Talaria.",
        "Apply",
        "Approval needed",
        "Archived Cards",
        "Archived Chats",
        "Assigned Profile",
        "Audio unavailable",
        "Audio",
        "Cancel recording",
        "Card Filters",
        "Change or clear the filters to see more Cards.",
        "Changes Committed",
        "Chat List",
        "Check for updates",
        "Check that the Hermes server is awake, then try again.",
        "Check your connection, then try again.",
        "Checking connection…",
        "Checking for updates…",
        "Choose a session from the sidebar or start a new chat.",
        "Choose another Status or refresh the Board.",
        "Choose whether %@ stops sending relay updates to this iPhone or every device on this Talaria Relay account.",
        "Choose which details and filters appear in the chat list.",
        "Collapse All",
        "Collapse file changes",
        "Collapse webhook sessions",
        "Commit %@",
        "Commit & Push",
        "Commit & push complete",
        "Commit Changes",
        "Commit Selected",
        "Commit and push",
        "Commit complete",
        "Commit message",
        "Commit",
        "Committed — push failed",
        "Committed, but the push failed.",
        "Committing...",
        "Connect %@",
        "Connect a server to Talaria Relay to enable remote alerts.",
        "Connected to %@",
        "Connecting",
        "Connecting…",
        "Connection",
        "Connection ok. Continue with SSO.",
        "Connection ok. Password or SSO available.",
        "Continue with SSO",
        "Context usage loading",
        "Context usage",
        "Conversation",
        "Could not load file.",
        "Could not load media.",
        "Could not refresh this Board. Previously loaded Cards remain visible.",
        "Couldn't check for updates",
        "Couldn't play this audio",
        "Couldn't read the recorded voice note. Try again.",
        "Couldn't start recording. Try again.",
        "Couldn't transcribe that voice note. Try recording again.",
        "Covers the git menu, composer branch picker, and the turn-end Commit & Push button and File changes recap.",
        "Data & Storage",
        "Delivered for servers connected to Talaria Relay.",
        "Dictation Provider",
        "Diff was large; message may be partial.",
        "Diffs for this turn aren't available yet.",
        "Disable",
        "Disabled",
        "Discard Changes",
        "Discard local changes?",
        "Discard",
        "Disconnect Pending",
        "Download %@",
        "Download Failed",
        "Enable",
        "Enrollment options for %@",
        "Enter a commit message first.",
        "Expand All",
        "Expand file changes",
        "Expand webhook sessions",
        "Export audio %@",
        "Export media",
        "File changes",
        "Files Button",
        "Generating commit message...",
        "Git Actions",
        "Hermes Media",
        "Include Archived Cards",
        "Included Chats",
        "Input needed",
        "Just now",
        "Kanban could not reach the server.",
        "Kanban is available with limited capabilities.",
        "Live Activities & Widgets",
        "Loading Kanban",
        "Loading audio",
        "Main Page",
        "Media saved to Photos.",
        "Microphone access is disabled. Enable it in Settings to record a voice note.",
        "New Chat in Profile",
        "New Chat with Voice",
        "New chat in ${profile}",
        "No Cards in this Status",
        "No File Diffs",
        "No Kanban changes were made.",
        "No commit message could be generated.",
        "No matching Cards",
        "Not Connected",
        "Notifications & Haptics",
        "On-device first",
        "On-device only keeps composer dictation audio off your Hermes server.",
        "On-device only",
        "On-device speech recognition is not available for the current locale.",
        "Open Talaria on a new chat and start voice dictation.",
        "Open Talaria on a new chat pinned to a specific profile.",
        "Open media video %@",
        "Pause %@",
        "Pause audio",
        "Photos can save images and videos. Export audio to Files instead.",
        "Photos could not save this media.",
        "Play %@",
        "Play audio",
        "Playback position for %@",
        "Playback position",
        "Playback speed",
        "Preparing audio",
        "Preview is not available for this media without a server session.",
        "Push after commit",
        "Push failed: %@",
        "Quota Display",
        "Quota Percentage",
        "Reconnect to the server to send a voice note.",
        "Record voice note",
        "Recording voice note",
        "Recording voice note, %@",
        "Recording...",
        "Refreshing Board",
        "Release to cancel",
        "Requesting microphone access...",
        "Return to the server login screen, then try again.",
        "Save media to Photos",
        "Search Cards",
        "Search Sessions",
        "Select a Chat",
        "Send Message",
        "Sending voice note...",
        "Server Access",
        "Server Identity",
        "Server first",
        "Server speech-to-text is not configured.",
        "Shows archived sessions.",
        "Sign In Required",
        "Sign Out of Talaria Relay",
        "Sign in for remote Live Activities and alerts",
        "Sign in for remote Live Activities",
        "Sign in is required for Kanban.",
        "Sign out of Talaria Relay?",
        "Signed Out",
        "Signing out stops remote Live Activities and alerts. Your server settings stay on this iPhone.",
        "SSO sign-in was cancelled.",
        "Slide up to cancel",
        "Something went wrong reaching the server. Try again in a moment.",
        "Speech-to-text is not available right now.",
        "Stage Changes…",
        "Stage",
        "Staged",
        "Stop audio",
        "Storage",
        "Subagent Sessions",
        "Suggest commit message",
        "Switch Board",
        "Talaria Relay",
        "Talaria couldn't open the SSO sign-in window. Try again.",
        "Talaria couldn't start a secure SSO flow. Try again.",
        "Talaria response %lld",
        "Talaria response",
        "Tap to download",
        "That SSO response was already used. Start again.",
        "The Hermes server is running the latest version.",
        "The SSO provider couldn't complete sign-in. Try again.",
        "The SSO response didn't match this server. Try signing in again.",
        "The SSO sign-in expired. Start again.",
        "The server didn't confirm which profile this sign-in uses. Try again.",
        "The Kanban server is unavailable.",
        "There are no changes to commit.",
        "Thinking & Tools",
        "This file is not a video that can be saved to Photos.",
        "This iPhone",
        "This removes local uncommitted changes and deletes untracked files. This cannot be undone.",
        "This removes local uncommitted changes. This cannot be undone.",
        "This server doesn't offer single sign-on.",
        "This server needs a newer secure SSO handoff before Talaria can sign in.",
        "This server's Kanban response is incompatible with Talaria.",
        "This signs this iPhone out of Talaria Relay. Your Hermes server settings stay on the device.",
        "Too many changes to quick-commit (over 500 files). Commit in smaller batches, or use git directly.",
        "Too many changes to quick-commit. Commit in smaller batches, or use git directly.",
        "Transcribing...",
        "Transcription returned no text.",
        "Turn off the entries you never use to shorten the top of the session list. Each one is the only way into its screen, so turn it back on here when you need it again.",
        "Unenroll %@?",
        "Unenroll Server?",
        "Unenrolling",
        "Unknown Card",
        "Unstage",
        "Unsupported: %@",
        "Untitled Card",
        "Update checks are off",
        "Update checks are turned off on this server.",
        "Video",
        "Voice input could not start recording. Try again in a moment.",
        "Waiting for server",
        "Waiting",
        "Webhook Sessions",
        "Webhook sessions",
        "You're up to date",
        "↑%lld ↓%lld",
    ]

    private func resourceURL(_ relativePath: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // TalariaKitTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // TalariaKit
            .deletingLastPathComponent()   // app
            .appendingPathComponent(relativePath)
    }

    private func catalogURL() -> URL {
        // .../TalariaTests/LocalizationCatalogTests.swift
        //   -> repo root -> Talaria/Resources/Localizable.xcstrings
        resourceURL("Talaria/Resources/Localizable.xcstrings")
    }

    private func catalogStrings(from data: Data) throws -> [String: Any] {
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(root["sourceLanguage"] as? String, "en", "Development language should remain English.")
        return try XCTUnwrap(root["strings"] as? [String: Any])
    }

    private func catalogStrings(
        at relativePath: String = "Talaria/Resources/Localizable.xcstrings"
    ) throws -> [String: Any] {
        try catalogStrings(from: Data(contentsOf: resourceURL(relativePath)))
    }

    private func catalogLanguages(at relativePath: String) throws -> Set<String> {
        let strings = try catalogStrings(at: relativePath)
        var languages = Set<String>()
        for case let entry as [String: Any] in strings.values {
            if let localizations = entry["localizations"] as? [String: Any] {
                languages.formUnion(localizations.keys)
            }
        }
        return languages
    }

    private func projectKnownRegions() throws -> Set<String> {
        let project = try String(
            contentsOf: resourceURL("Talaria.xcodeproj/project.pbxproj"),
            encoding: .utf8
        )
        let regex = try NSRegularExpression(
            pattern: #"knownRegions = \((.*?)\);"#,
            options: .dotMatchesLineSeparators
        )
        let match = try XCTUnwrap(
            regex.firstMatch(in: project, range: NSRange(project.startIndex..., in: project))
        )
        let range = try XCTUnwrap(Range(match.range(at: 1), in: project))
        return Set(project[range].split(separator: ",").compactMap {
            let region = $0.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            return region.isEmpty ? nil : region
        })
    }

    /// True iff the language entry holds a non-empty value — either a plain `stringUnit` or
    /// a `plural` variation where every category is filled.
    private func hasNonEmptyValue(_ localization: [String: Any]) -> Bool {
        if let value = (localization["stringUnit"] as? [String: Any])?["value"] as? String {
            return !value.isEmpty
        }
        if let plural = ((localization["variations"] as? [String: Any])?["plural"] as? [String: Any]), !plural.isEmpty {
            return plural.values.allSatisfy { cat in
                let value = ((cat as? [String: Any])?["stringUnit"] as? [String: Any])?["value"] as? String
                return !(value ?? "").isEmpty
            }
        }
        return false
    }

    func testLocalizedEntriesHaveNoEmptyShippedLanguageValues() throws {
        let url = catalogURL()
        guard let data = try? Data(contentsOf: url) else {
            throw XCTSkip("Could not read String Catalog at \(url.path); skipping — the source tree is not present in this environment (e.g. on a physical device or a remote test runner). Runs on the simulator/CI where the checkout exists.")
        }
        let strings = try catalogStrings(from: data)
        XCTAssertGreaterThan(strings.count, 200, "Catalog is unexpectedly small — string extraction may have regressed.")

        for language in Self.shippedLanguages {
            var missing: [String] = []
            var translated = 0

            for (key, rawEntry) in strings {
                guard let entry = rawEntry as? [String: Any] else { continue }
                if entry["shouldTranslate"] as? Bool == false { continue }   // intentionally excluded
                if Self.intentionallyStagedKeys.contains(key) { continue }
                let localizations = entry["localizations"] as? [String: Any] ?? [:]

                guard let localization = localizations[language] as? [String: Any] else {
                    missing.append(key)
                    continue
                }
                hasNonEmptyValue(localization) ? (translated += 1) : missing.append(key)
            }

            XCTAssertTrue(missing.isEmpty,
                          "[\(language)] \(missing.count) translatable key(s) have no value: \(missing.sorted())")
            XCTAssertGreaterThan(translated, 200, "[\(language)] Far fewer translations than expected — something dropped.")
        }
    }

    func testKeysWithoutShippedTranslationsMatchExplicitStagingAllowlist() throws {
        let strings = try catalogStrings()
        let stagedKeys = Set(strings.compactMap { key, rawEntry -> String? in
            guard let entry = rawEntry as? [String: Any],
                  entry["shouldTranslate"] as? Bool != false else {
                return nil
            }
            let localizations = entry["localizations"] as? [String: Any] ?? [:]
            return Self.shippedLanguages.contains(where: { localizations[$0] != nil }) ? nil : key
        })
        let unexpected = stagedKeys.subtracting(Self.intentionallyStagedKeys)
        let stale = Self.intentionallyStagedKeys.subtracting(stagedKeys)

        XCTAssertTrue(
            unexpected.isEmpty,
            "Unstaged source-only key(s) \(unexpected.sorted()) are missing languages \(Self.shippedLanguages)."
        )
        XCTAssertTrue(
            stale.isEmpty,
            "Remove translated, excluded, or deleted key(s) from intentionallyStagedKeys: \(stale.sorted())."
        )
    }

    func testShippedLanguageDeclarationsStayAligned() throws {
        let expected = Set(Self.shippedLanguages + ["en"])
        XCTAssertEqual(try projectKnownRegions(), expected.union(["Base"]))
        XCTAssertEqual(try catalogLanguages(at: "Talaria/Resources/Localizable.xcstrings"), expected)
        XCTAssertEqual(try catalogLanguages(at: "Talaria/Resources/AppShortcuts.xcstrings"), expected)
    }

    func testAppShortcutPhrasesHaveDedicatedCatalogEntries() throws {
        let strings = try catalogStrings(at: "Talaria/Resources/AppShortcuts.xcstrings")
        let expectedPhrases = [
            "New chat in ${applicationName}",
            "New ${applicationName} chat",
            "Start a new chat in ${applicationName}",
            "New voice chat in ${applicationName}",
            "New ${applicationName} voice chat",
            "Start a voice chat in ${applicationName}",
            "New ${profile} chat in ${applicationName}",
            "Start a new ${profile} chat in ${applicationName}",
            "New chat in ${profile} on ${applicationName}"
        ]

        XCTAssertEqual(Set(strings.keys), Set(expectedPhrases))

        for phrase in expectedPhrases {
            let entry = try XCTUnwrap(strings[phrase] as? [String: Any], phrase)
            let localizations = try XCTUnwrap(entry["localizations"] as? [String: Any], phrase)
            for language in Self.shippedLanguages + ["en"] {
                let localization = try XCTUnwrap(localizations[language] as? [String: Any], "[\(language)] \(phrase)")
                XCTAssertTrue(hasNonEmptyValue(localization), "[\(language)] \(phrase) is empty")
            }
        }
    }

    func testKanbanCardDetailCopyIsLocalizedInEveryShippedLanguage() throws {
        let strings = try catalogStrings()
        let detailKeys = [
            "Card ID", "Comment", "Comment cannot be blank.", "Created", "Dependencies",
            "Description", "Dispatch Runs", "Events", "Maximum Runtime", "Metadata",
            "Operational History", "Operational Metadata", "Outcome Uncertain", "Priority",
            "Run ID", "Updated", "Worker ID", "Worker Log",
            "This Board no longer exists. Return to Kanban to choose another Board.",
            "This Card no longer exists on this Board. The Board has been refreshed."
        ]

        for key in detailKeys {
            let entry = try XCTUnwrap(strings[key] as? [String: Any], key)
            let localizations = try XCTUnwrap(entry["localizations"] as? [String: Any], key)
            for language in Self.shippedLanguages {
                let localization = try XCTUnwrap(
                    localizations[language] as? [String: Any],
                    "[\(language)] \(key)"
                )
                XCTAssertTrue(hasNonEmptyValue(localization), "[\(language)] \(key) is empty")
            }
        }
    }

    func testKanbanCardEditorCopyIsLocalizedInEveryShippedLanguage() throws {
        let strings = try catalogStrings()
        let editorKeys = [
            "Edit Card", "New Card", "Title", "Title is required.", "Assignment", "Execution",
            "Prerequisite", "Create Ready, Unassigned Card?", "Reload Server Version",
            "Review and Overwrite", "This Card changed on the server after the editor opened. Your draft has been preserved.",
            "Workspace, Skills, Maximum Runtime, and Prerequisite are set when the Card is created and cannot be edited here."
        ]

        for key in editorKeys {
            let entry = try XCTUnwrap(strings[key] as? [String: Any], key)
            let localizations = try XCTUnwrap(entry["localizations"] as? [String: Any], key)
            for language in Self.shippedLanguages {
                let localization = try XCTUnwrap(
                    localizations[language] as? [String: Any],
                    "[\(language)] \(key)"
                )
                XCTAssertTrue(hasNonEmptyValue(localization), "[\(language)] \(key) is empty")
                let translatedValue = (localization["stringUnit"] as? [String: Any])?["value"] as? String
                XCTAssertNotEqual(translatedValue, key, "[\(language)] \(key) still uses the English source value")
            }
        }
    }

    func testKanbanBulkActionNamesAreLocalizedInEveryShippedLanguage() throws {
        let strings = try catalogStrings()
        let bulkActionKeys = [
            "Archive Cards", "Assign Profile", "Bulk Actions", "Change Status",
            "Retry Failed", "Select Cards", "Set Priority", "Unknown Status",
            "The Board is refreshing.",
            "The selection is no longer available. Refresh the Board and select the Cards again.",
            "The selected Cards will be moved to the archive."
        ]

        for key in bulkActionKeys {
            let entry = try XCTUnwrap(strings[key] as? [String: Any], key)
            let localizations = try XCTUnwrap(entry["localizations"] as? [String: Any], key)
            for language in Self.shippedLanguages {
                let localization = try XCTUnwrap(
                    localizations[language] as? [String: Any],
                    "[\(language)] \(key)"
                )
                XCTAssertTrue(hasNonEmptyValue(localization), "[\(language)] \(key) is empty")
                let translatedValue = (localization["stringUnit"] as? [String: Any])?["value"] as? String
                XCTAssertNotEqual(translatedValue, key, "[\(language)] \(key) still uses the English source value")
            }
        }
    }

    func testKanbanBoardManagementCopyIsLocalizedInEveryShippedLanguage() throws {
        let strings = try catalogStrings()
        let boardKeys = [
            "Board actions for %@",
            "Browse Board",
            "Browse Board: %@",
            "Browsing",
            "Browsing a Board stays local to Talaria. Making a Board active changes shared server state.",
            "Check Result",
            "Choose Board",
            "Creating a Board does not make it active.",
            "Talaria cannot restore an archived Board in-app.",
            "Icon",
            "Make Active Board",
            "Making this Board active changes shared server state for other Hermes clients.",
            "Shows available Board management actions.",
            "Slug",
            "The slug cannot be changed after the Board is created.",
            "This Board no longer exists. Choose another Board.",
            "Updating Board..."
        ]

        for key in boardKeys {
            let entry = try XCTUnwrap(strings[key] as? [String: Any], key)
            let localizations = try XCTUnwrap(entry["localizations"] as? [String: Any], key)
            for language in Self.shippedLanguages {
                let localization = try XCTUnwrap(
                    localizations[language] as? [String: Any],
                    "[\(language)] \(key)"
                )
                XCTAssertTrue(hasNonEmptyValue(localization), "[\(language)] \(key) is empty")
                let translatedValue = (localization["stringUnit"] as? [String: Any])?["value"] as? String
                XCTAssertNotEqual(translatedValue, key, "[\(language)] \(key) still uses English")
            }
        }
    }

    func testKanbanDispatcherCopyIsLocalizedInEveryShippedLanguage() throws {
        let strings = try catalogStrings()
        let dispatcherKeys = [
            "Another Board action is in progress.",
            "Auto-blocked",
            "Crashed",
            "Display",
            "Dispatcher",
            "Dispatcher, attention required",
            "Dispatcher, result available",
            "Dispatcher is unavailable on this server.",
            "Group by Profile",
            "Talaria refreshed the Board, but cannot prove whether workers started. Review the current Board before running Dispatcher again.",
            "I Reviewed the Board",
            "Preview Dispatch",
            "Preview is advisory and may become stale. It never starts workers.",
            "Promoted",
            "Reclaimed",
            "Refresh failed. Try again before using Dispatcher.",
            "Run Dispatcher",
            "Running Dispatcher...",
            "Skipped—No Assignee",
            "Skipped—Unknown Profile",
            "Spawned",
            "The server refused this Dispatcher request. Talaria did not retry it.",
            "This Preview is stale. Run Preview Dispatch again before relying on it.",
            "This may start up to %lld workers and consume API budget.",
            "Timed Out"
        ]

        for key in dispatcherKeys {
            let entry = try XCTUnwrap(strings[key] as? [String: Any], key)
            let localizations = try XCTUnwrap(entry["localizations"] as? [String: Any], key)
            for language in Self.shippedLanguages {
                let localization = try XCTUnwrap(
                    localizations[language] as? [String: Any],
                    "[\(language)] \(key)"
                )
                XCTAssertTrue(hasNonEmptyValue(localization), "[\(language)] \(key) is empty")
            }
        }
    }
}
