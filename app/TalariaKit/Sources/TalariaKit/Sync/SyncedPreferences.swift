import Foundation

/// The explicit allowlist of durable, user-chosen preferences that travel
/// between a user's devices. Everything else in UserDefaults stays on the
/// device: cached server responses, permission flags, push tokens, widget
/// snapshots, per-server toggles, and anything the OS owns.
enum SyncedPreferenceAllowlist {
    enum Suite: Equatable {
        case standard
        /// Widget appearance lives in the app group so the widget can read it.
        case appGroup
    }

    struct Entry: Equatable {
        let key: String
        let suite: Suite
    }

    static let allowlist: [Entry] = [
        .init(key: AppTheme.storageKey, suite: .standard),
        .init(key: PrimaryActionTintSettings.isEnabledKey, suite: .standard),
        .init(key: GlassPreference.isEnabledKey, suite: .standard),
        .init(key: AppHaptics.isEnabledKey, suite: .standard),
        .init(key: AgentRunLiveActivityPrivacy.showsResponseExcerptsKey, suite: .standard),
        .init(key: TalariaLiveActivityMode.storageKey, suite: .standard),
        .init(key: StreamedTextAnimationSettings.isEnabledKey, suite: .standard),
        .init(key: StreamingSendBehavior.storageKey, suite: .standard),
        .init(key: ComposerSTTProviderPreference.storageKey, suite: .standard),
        .init(key: ListenPlaybackSpeed.storageKey, suite: .standard),
        .init(key: ChatTranscriptDisplaySettings.showsThinkingAndToolCardsKey, suite: .standard),
        .init(key: ChatTranscriptDisplaySettings.thinkingCardsStartExpandedKey, suite: .standard),
        .init(key: ChatTranscriptDisplaySettings.toolCardsStartExpandedKey, suite: .standard),
        .init(key: ChatTranscriptDisplaySettings.hidesAttachmentPathsKey, suite: .standard),
        .init(key: ChatTranscriptDisplaySettings.showsAssistantTurnTimestampsKey, suite: .standard),
        .init(key: ChatTranscriptDisplaySettings.showsResponseSpeedKey, suite: .standard),
        .init(key: ChatTranscriptDisplaySettings.wrapsCodeBlockLinesKey, suite: .standard),
        .init(key: ChatTranscriptDisplaySettings.rtlChatLayoutEnabledKey, suite: .standard),
        .init(key: ChatScrollToBottomButtonSide.storageKey, suite: .standard),
        .init(key: SectionVisibilitySettings.tasksKey, suite: .standard),
        .init(key: SectionVisibilitySettings.kanbanKey, suite: .standard),
        .init(key: SectionVisibilitySettings.skillsKey, suite: .standard),
        .init(key: SectionVisibilitySettings.memoryKey, suite: .standard),
        .init(key: SectionVisibilitySettings.insightsKey, suite: .standard),
        .init(key: SectionVisibilitySettings.activeProfileKey, suite: .standard),
        .init(key: SectionVisibilitySettings.projectsKey, suite: .standard),
        .init(key: SectionVisibilitySettings.chatFilesKey, suite: .standard),
        .init(key: SectionVisibilitySettings.chatGitKey, suite: .standard),
        .init(key: ComposerVisibilitySettings.workspaceKey, suite: .standard),
        .init(key: ComposerVisibilitySettings.profileKey, suite: .standard),
        .init(key: ComposerVisibilitySettings.gitBranchKey, suite: .standard),
        .init(key: ComposerVisibilitySettings.contextUsageKey, suite: .standard),
        .init(key: ComposerVisibilitySettings.controlStripKey, suite: .standard),
        .init(key: SessionRowDisplaySettings.showMessageCountKey, suite: .standard),
        .init(key: SessionRowDisplaySettings.showWorkspaceKey, suite: .standard),
        .init(key: SessionRowDisplaySettings.showCronSessionsKey, suite: .standard),
        .init(key: SessionRowDisplaySettings.showWebhookSessionsKey, suite: .standard),
        .init(key: SessionRowDisplaySettings.showSubagentSessionsKey, suite: .standard),
        .init(key: ProviderQuotaSidebarSettings.firstSourceKey, suite: .standard),
        .init(key: ProviderQuotaSidebarSettings.secondSourceKey, suite: .standard),
        .init(key: ProviderQuotaSidebarSettings.detailKey, suite: .standard),
        .init(key: ProviderQuotaSidebarSettings.showsRailKey, suite: .standard),
        .init(key: ProviderQuotaSidebarSettings.showsMarkerKey, suite: .standard),
        .init(key: ProviderQuotaSidebarSettings.showsIconKey, suite: .standard),
        .init(key: ProviderQuotaSidebarSettings.colorsByStateKey, suite: .standard),
        .init(key: ProviderQuotaVisibilitySettings.storageKey, suite: .standard),
        .init(key: ProviderQuotaRefreshInterval.storageKey, suite: .standard),
        .init(key: ProviderQuotaAlertSettings.isEnabledKey, suite: .standard),
        .init(key: ProviderQuotaAlertSettings.warningEnabledKey, suite: .standard),
        .init(key: ProviderQuotaAlertSettings.criticalEnabledKey, suite: .standard),
        .init(key: ProviderQuotaAlertSettings.criticalTimeSensitiveKey, suite: .standard),
        .init(key: ProviderIconStyle.storageKey, suite: .appGroup),
        .init(key: ProviderQuotaDisplaySettings.aliasesKey, suite: .appGroup),
        .init(key: ProviderQuotaPercentageMode.storageKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetArcColor.storageKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetArcWeight.storageKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetColorBasis.storageKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetStorageKeys.windowSelection, suite: .appGroup),
        .init(key: ProviderQuotaWidgetStorageKeys.statusText, suite: .appGroup),
        .init(key: ProviderQuotaWidgetStorageKeys.resetDisplay, suite: .appGroup),
        .init(key: ProviderQuotaWidgetStorageKeys.tapAction, suite: .appGroup),
        .init(key: ProviderQuotaWidgetStorageKeys.background, suite: .appGroup),
        .init(key: ProviderQuotaWidgetStorageKeys.backgroundCustomColorHex, suite: .appGroup),
        .init(key: ProviderQuotaWidgetStorageKeys.backgroundOpacityPercent, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.showsProviderIconKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.providerIconStyleKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.healthyColorKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.warningColorKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.criticalColorKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.staleColorKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.unavailableColorKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.showsPaceMarkerKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.trackColorKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.trackOpacityPercentKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.customArcColorHexKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.customTrackColorHexKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.customHealthyColorHexKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.customWarningColorHexKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.customCriticalColorHexKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.customStaleColorHexKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetAppearanceSettings.customUnavailableColorHexKey, suite: .appGroup),
        .init(key: ProviderQuotaLockScreenSettings.showsProviderIconKey, suite: .appGroup),
        .init(key: ProviderQuotaLockScreenSettings.showsResetKey, suite: .appGroup),
        .init(key: ProviderQuotaLockScreenSettings.showsWindowKey, suite: .appGroup),
        .init(key: ProviderQuotaLockScreenSettings.paceDetailKey, suite: .appGroup),
        .init(key: ProviderQuotaWidgetStorageKeys.profiles, suite: .appGroup),
        .init(key: ProviderQuotaWidgetStorageKeys.selectedDefaultProfile, suite: .appGroup),
    ]

    /// Keys whose synced JSON value carries `Data` (base64 under `"$data"`).
    private static let dataMarker = "$data"

    /// The current values of every allowlisted key that is set. Unset keys are
    /// omitted so a device that never touched a setting does not push the
    /// default over another device's choice.
    static func snapshot(standard: UserDefaults, appGroup: UserDefaults) -> [String: JSONValue] {
        var values: [String: JSONValue] = [:]
        for entry in allowlist {
            let defaults = entry.suite == .standard ? standard : appGroup
            guard let object = defaults.object(forKey: entry.key),
                  let value = jsonValue(from: object) else { continue }
            values[entry.key] = value
        }
        return values
    }

    /// Makes the local allowlisted keys match `values`: keys the snapshot
    /// carries are written, keys it omits are removed (a preference cleared on
    /// another device clears here too). Anything not allowlisted is ignored.
    /// Returns whether any stored value changed.
    @discardableResult
    static func apply(_ values: [String: JSONValue], standard: UserDefaults, appGroup: UserDefaults) -> Bool {
        var changed = false
        for entry in allowlist {
            let defaults = entry.suite == .standard ? standard : appGroup
            let current = defaults.object(forKey: entry.key).flatMap(jsonValue(from:))
            guard let value = values[entry.key] else {
                if current != nil {
                    defaults.removeObject(forKey: entry.key)
                    changed = true
                }
                continue
            }
            guard current != value, let object = object(from: value) else { continue }
            defaults.set(object, forKey: entry.key)
            changed = true
        }
        return changed
    }

    static func jsonValue(from object: Any) -> JSONValue? {
        switch object {
        case let number as NSNumber:
            if CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID() {
                return .bool(number.boolValue)
            }
            return .number(number.doubleValue)
        case let string as String:
            return .string(string)
        case let data as Data:
            return .object([dataMarker: .string(data.base64EncodedString())])
        default:
            return nil
        }
    }

    static func object(from value: JSONValue) -> Any? {
        switch value {
        case .bool(let bool):
            return bool
        case .number(let number):
            // `@AppStorage(Int)` reads through `integer(forKey:)`, which converts a
            // Double, but storing whole numbers as Int keeps the defaults plist
            // identical to what the toggle itself would have written.
            if number == number.rounded(), abs(number) < Double(Int.max) {
                return Int(number)
            }
            return number
        case .string(let string):
            return string
        case .object(let object):
            guard case .string(let base64)? = object[dataMarker] else { return nil }
            return Data(base64Encoded: base64)
        case .array, .null:
            return nil
        }
    }
}
