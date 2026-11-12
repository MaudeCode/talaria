import Foundation

/// The labels, storage owners and destinations used by Settings rows and root search.
public enum SettingsIndex: String, CaseIterable, Identifiable, Sendable {
    case appearanceTheme = "settings-appearance-theme"
    case appearanceAccentColor = "settings-appearance-accent-color"
    case appearanceCustom = "settings-appearance-custom"
    case appearanceTintNewChatSend = "settings-appearance-tint-new-chat-send"
    case appearanceAppIcon = "settings-appearance-app-icon"
    case chatSendWhileResponding = "settings-chat-send-while-responding"
    case chatSendWith = "settings-chat-send-with"
    case chatWorkspace = "settings-chat-workspace"
    case chatProfile = "settings-chat-profile"
    case chatGitBranch = "settings-chat-git-branch"
    case chatContextUsage = "settings-chat-context-usage"
    case chatThinkingTools = "settings-chat-thinking-tools"
    case chatExpandThinkingByDefault = "settings-chat-expand-thinking-by-default"
    case chatExpandToolsByDefault = "settings-chat-expand-tools-by-default"
    case chatStreamedTextAnimation = "settings-chat-streamed-text-animation"
    case chatResponseTimestamps = "settings-chat-response-timestamps"
    case chatResponseSpeed = "settings-chat-response-speed"
    case chatWrapCodeBlockLines = "settings-chat-wrap-code-block-lines"
    case chatScrollButtonSide = "settings-chat-scroll-button-side"
    case chatRightToLeftChatLayout = "settings-chat-right-to-left-chat-layout"
    case chatFilesButton = "settings-chat-files-button"
    case chatOpensAgentFileAutomatically = "settings-chat-open-the-agent-s-file-automatically"
    case chatGitActions = "settings-chat-git-actions"
    case navigationTasks = "settings-navigation-section-tasks"
    case navigationKanban = "settings-navigation-section-kanban"
    case navigationSkills = "settings-navigation-section-skills"
    case navigationMemory = "settings-navigation-section-memory"
    case navigationInsights = "settings-navigation-section-insights"
    case navigationFeedbackButton = "settings-sidebar-feedback-toggle"
    case navigationCronSessions = "settings-navigation-cron-sessions"
    case navigationWebhookSessions = "settings-navigation-webhook-sessions"
    case navigationCLISessions = "settings-navigation-cli-sessions"
    case navigationClaudeCodeSessions = "settings-navigation-claude-code-sessions"
    case navigationSubagentSessions = "settings-navigation-subagent-sessions"
    case navigationSidebarQuotas = "settings-navigation-sidebar-quotas"
    case navigationProviderIcons = "settings-navigation-provider-icons"
    case navigationQuotaPercentage = "settings-navigation-quota-percentage"
    case navigationQuotaRefresh = "settings-navigation-quota-refresh"
    case notificationsHapticFeedback = "settings-notifications-haptic-feedback"
    case notificationsResponseCompleteAlerts = "settings-notifications-response-complete-alerts"
    case notificationsApprovalAndQuestionAlerts = "settings-notifications-approval-and-question-alerts"
    case notificationsApprovalInputAlerts = "settings-notifications-approval-input-alerts"
    case notificationsProviderQuotaAlerts = "settings-notifications-provider-quota-alerts"
    case notificationsWarningAlerts = "settings-notifications-warning-alerts"
    case notificationsCriticalAlerts = "settings-notifications-critical-alerts"
    case notificationsTimeSensitive = "settings-notifications-time-sensitive"
    case speechDictationProvider = "settings-speech-dictation-provider"
    case modelsDefaultModel = "settings-models-default-model"
    case modelsDefaultReasoning = "settings-models-default-reasoning"
    case modelsShowThinking = "settings-models-show-thinking"
    case modelsAuxiliaryModels = "settings-models-auxiliary-models"
    case modelsMaxTokens = "settings-chat-max-tokens"
    case modelsPrepareCompressionAhead = "settings-chat-compression-ahead"
    case systemRefreshTitlesEvery = "settings-chat-title-refresh"
    case providersManageProviders = "settings-providers-providers"
    case toolsAgentApprovals = "settings-tools-agent-approvals"
    case profilesList = "settings-profile-row-"
    case profilesNewProfile = "settings-profiles-new-profile"
    case workspacesAddWorkspace = "settings-workspaces-add-workspace"
    case systemCheckForUpdates = "settings-system-check-updates"
    case systemApplyWebUpdatesAutomatically = "settings-system-auto-apply"
    case systemSummarizeUpdates = "settings-system-summarize"
    case systemWebChannel = "settings-system-web-channel"
    case systemAgentChannel = "settings-system-agent-channel"
    case systemIgnoreAgentUpdates = "settings-system-ignore-agent"
    case systemStatus = "settings-system-status"
    case systemVersion = "settings-system-version"
    case systemCheckNow = "settings-system-check-for-updates-system"
    case systemHermesAgent = "settings-system-hermes-agent"
    case systemUpdate = "settings-system-update"
    case systemUpdateSummary = "settings-system-update-summary"
    case logsFile = "settings-logs-file"
    case logsLines = "settings-logs-lines"
    case logsLogText = "settings-logs-text"
    case logsShare = "settings-logs-share"
    case serversList = "settings-servers-account-"
    case serversAddServer = "settings-servers-add-server"
    case serversConnectionHeaders = "settings-servers-connection-headers"
    case serversSignOutOfThisServer = "settings-servers-sign-out-of-this-server"
    case liveActivitiesAndWidgetsDisplay = "settings-liveActivitiesAndWidgets-display"
    case liveActivitiesAndWidgetsLiveActivityExcerpts = "settings-liveActivitiesAndWidgets-live-activity-excerpts"
    case liveActivitiesAndWidgetsProviderQuotas = "settings-liveActivitiesAndWidgets-provider-quotas"
    case siriAndShortcutsOpenTalariaSettings = "settings-siriAndShortcuts-open-talaria-settings"
    case dataAndStorageClearOfflineCache = "settings-dataAndStorage-clear-offline-cache"
    case dataAndStorageAppLock = "settings-app-lock"
    case aboutVersion = "settings-about-version"
    case aboutBuild = "settings-about-build"
    case aboutWhatsNew = "settings-whats-new"
    case aboutSendFeedback = "settings-send-feedback"
    case aboutPrivacyPolicy = "settings-about-privacy-policy"
    case aboutSupport = "settings-about-support"
    case aboutAcknowledgements = "settings-about-acknowledgements"
    case developerStreamingLab = "settings-developer-streaming-lab"
    case sidebarQuotasDetail = "settings-sidebarQuotas-detail"
    case sidebarQuotasProviderIcon = "settings-sidebarQuotas-provider-icon"
    case sidebarQuotasQuotaRail = "settings-sidebarQuotas-quota-rail"
    case sidebarQuotasPaceMarker = "settings-sidebarQuotas-pace-marker"
    case sidebarQuotasColorByState = "settings-sidebarQuotas-color-by-state"
    case widgetColor = "settings-widget-color"
    case widgetCustomColor = "settings-widget-custom-color"
    case widgetWeight = "settings-widget-weight"
    case widgetAutomaticColor = "settings-widget-automatic-color"
    case widgetShowPaceMarker = "settings-widget-show-pace-marker"
    case widgetProviderIcon = "settings-widget-provider-icon"
    case widgetIconStyle = "settings-widget-icon-style"
    case widgetStatus = "settings-widget-status"
    case widgetReset = "settings-widget-reset"
    case widgetLockScreenProviderIcon = "settings-widget-provider-icon-lock-screen"
    case widgetResetTime = "settings-widget-reset-time"
    case widgetQuotaWindow = "settings-widget-quota-window"
    case widgetPaceFooter = "settings-widget-pace-footer"
    case widgetTrackColor = "settings-widget-track-color"
    case widgetCustomTrackColor = "settings-widget-custom-track-color"
    case widgetTrackOpacity = "settings-widget-track-opacity"
    case widgetBackground = "settings-widget-background"
    case widgetCustomBackgroundColor = "settings-widget-custom-background-color"
    case widgetBackgroundOpacity = "settings-widget-background-opacity"
    case widgetTap = "settings-widget-tap"
    case widgetHealthy = "settings-widget-healthy"
    case widgetWarning = "settings-widget-warning"
    case widgetCritical = "settings-widget-critical"
    case widgetStale = "settings-widget-stale"
    case widgetUnavailable = "settings-widget-unavailable"
    case providersOverPaceAt = "settings-providers-over-pace-at"
    case providersWarningBurnRate = "settings-providers-warning-burn-rate"
    case providersCriticalBurnRate = "settings-providers-critical-burn-rate"
    case providersProjectionAfter = "settings-providers-projection-after"
    case providersWarningAt = "settings-providers-warning-at"
    case providersCriticalAt = "settings-providers-critical-at"
    case userProfileSessionsAvatar = "settings-userProfile-sessions-avatar"
    case userProfileDisplayName = "settings-userProfile-display-name"
    case userProfileInitials = "settings-userProfile-initials"
    case appleAccountContinueWithApple = "settings-sign-in-with-apple"
    case appleAccountSyncServersSettings = "settings-icloud-sync-toggle"
    case appleAccountICloudSync = "settings-icloud-sync-status"
    case appleAccountSyncNow = "settings-appleAccount-sync-now"

    case widgetCustomHealthyColor = "settings-widget-custom-healthy-color"
    case widgetCustomWarningColor = "settings-widget-custom-warning-color"
    case widgetCustomCriticalColor = "settings-widget-custom-critical-color"
    case widgetCustomStaleColor = "settings-widget-custom-stale-color"
    case widgetCustomUnavailableColor = "settings-widget-custom-unavailable-color"

    case widgetProfiles = "settings-widget-profiles"
    case widgetProfilesAppDefault = "settings-widget-profiles-app-default"
    case widgetProfilesSaved = "settings-widget-profile-row-"
    case widgetProfilesSaveCurrent = "settings-widget-profiles-save-current"
    case appleAccountRelay = "settings-manage-relay"
    case appleAccountDisconnect = "settings-disconnect-relay"
    case appleAccountDeleteSyncedData = "settings-icloud-sync-delete"

    public enum Scope: Sendable { case device, synced, profile, server }

    public var id: String { rawValue }
    public var category: SettingsCategory { definition.category }
    public var categoryTitle: String {
        switch page {
        case .userProfile: String(localized: "User Profile")
        case .appleAccount: String(localized: "Apple Account")
        default: category.title
        }
    }
    public var section: String { String(localized: definition.section) }
    public var title: String { String(localized: titleResource) }
    public var titleResource: LocalizedStringResource { definition.title }
    public var scope: Scope { definition.scope }
    public var page: SettingsPane {
        switch self {
        case .sidebarQuotasDetail, .sidebarQuotasProviderIcon, .sidebarQuotasQuotaRail, .sidebarQuotasPaceMarker, .sidebarQuotasColorByState: .sidebarQuotas
        case .widgetColor, .widgetCustomColor, .widgetWeight, .widgetAutomaticColor, .widgetShowPaceMarker, .widgetProviderIcon, .widgetIconStyle, .widgetStatus, .widgetReset, .widgetLockScreenProviderIcon, .widgetResetTime, .widgetQuotaWindow, .widgetPaceFooter, .widgetTrackColor, .widgetCustomTrackColor, .widgetTrackOpacity, .widgetBackground, .widgetCustomBackgroundColor, .widgetBackgroundOpacity, .widgetTap, .widgetHealthy, .widgetWarning, .widgetCritical, .widgetStale, .widgetUnavailable: .providerQuotaWidget
        case .widgetCustomHealthyColor, .widgetCustomWarningColor, .widgetCustomCriticalColor, .widgetCustomStaleColor, .widgetCustomUnavailableColor: .providerQuotaWidget
        case .widgetProfiles: .providerQuotaWidget
        case .widgetProfilesAppDefault, .widgetProfilesSaved, .widgetProfilesSaveCurrent: .widgetProfiles
        case .appleAccountRelay, .appleAccountDisconnect, .appleAccountDeleteSyncedData: .appleAccount
        case .userProfileSessionsAvatar, .userProfileDisplayName, .userProfileInitials: .userProfile
        case .appleAccountContinueWithApple, .appleAccountSyncServersSettings, .appleAccountICloudSync, .appleAccountSyncNow: .appleAccount
        default: .category(category)
        }
    }

    public func owns(identifier: String) -> Bool {
        if [.profilesList, .serversList, .widgetProfilesSaved].contains(self) { return identifier.hasPrefix(id) }
        if self == .systemStatus { return identifier == id || identifier.hasPrefix(id + "-") }
        return identifier == id
    }

    public static func search(_ query: String, locale: Locale = .current) -> [Self] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        return allCases.filter { entry in
            (entry.category != .developer || SettingsCategory.rootCategories.contains(.developer)) &&
            [entry.title, entry.section].contains {
                $0.range(of: query, options: [.caseInsensitive, .diacriticInsensitive], locale: locale) != nil
            }
        }
    }

    public static func row(title: String, page: SettingsPane, section: String?) -> Self? {
        allCases.first { $0.page == page && $0.title == title && (section == nil || $0.section == section) }
    }

    private struct Definition {
        let category: SettingsCategory
        let section: LocalizedStringResource
        let title: LocalizedStringResource
        let scope: Scope
    }

    private var definition: Definition {
        switch self {
        case .appearanceTheme: .init(category: .appearance, section: "Appearance", title: "Theme", scope: .synced)
        case .appearanceAccentColor: .init(category: .appearance, section: "Appearance", title: "Accent Color", scope: .synced)
        case .appearanceCustom: .init(category: .appearance, section: "Appearance", title: "Custom", scope: .synced)
        case .appearanceTintNewChatSend: .init(category: .appearance, section: "Appearance", title: "Tint New Chat & Send", scope: .synced)
        case .appearanceAppIcon: .init(category: .appearance, section: "Appearance", title: "App Icon", scope: .device)
        case .chatSendWhileResponding: .init(category: .chats, section: "Composer", title: "Send While Responding", scope: .synced)
        case .chatSendWith: .init(category: .chats, section: "Composer", title: "Send With", scope: .synced)
        case .chatWorkspace: .init(category: .chats, section: "Composer", title: "Workspace", scope: .synced)
        case .chatProfile: .init(category: .chats, section: "Composer", title: "Profile", scope: .synced)
        case .chatGitBranch: .init(category: .chats, section: "Composer", title: "Git Branch", scope: .synced)
        case .chatContextUsage: .init(category: .chats, section: "Composer", title: "Context Usage", scope: .synced)
        case .chatThinkingTools: .init(category: .chats, section: "Conversation", title: "Thinking & Tools", scope: .synced)
        case .chatExpandThinkingByDefault: .init(category: .chats, section: "Conversation", title: "Expand Thinking by Default", scope: .synced)
        case .chatExpandToolsByDefault: .init(category: .chats, section: "Conversation", title: "Expand Tools by Default", scope: .synced)
        case .chatStreamedTextAnimation: .init(category: .chats, section: "Conversation", title: "Streamed Text Animation", scope: .synced)
        case .chatResponseTimestamps: .init(category: .chats, section: "Conversation", title: "Response Timestamps", scope: .synced)
        case .chatResponseSpeed: .init(category: .chats, section: "Conversation", title: "Response Speed", scope: .synced)
        case .chatWrapCodeBlockLines: .init(category: .chats, section: "Conversation", title: "Wrap Code Block Lines", scope: .synced)
        case .chatScrollButtonSide: .init(category: .chats, section: "Conversation", title: "Scroll Button Side", scope: .synced)
        case .chatRightToLeftChatLayout: .init(category: .chats, section: "Conversation", title: "Right-to-Left Chat Layout", scope: .synced)
        case .chatFilesButton: .init(category: .chats, section: "Conversation", title: "Files Button", scope: .synced)
        case .chatOpensAgentFileAutomatically: .init(category: .chats, section: "Conversation", title: "Open the Agent's File Automatically", scope: .synced)
        case .chatGitActions: .init(category: .chats, section: "Conversation", title: "Git Actions", scope: .synced)
        case .navigationTasks: .init(category: .navigation, section: "Sidebar sections", title: "Tasks", scope: .synced)
        case .navigationKanban: .init(category: .navigation, section: "Sidebar sections", title: "Kanban", scope: .synced)
        case .navigationSkills: .init(category: .navigation, section: "Sidebar sections", title: "Skills", scope: .synced)
        case .navigationMemory: .init(category: .navigation, section: "Sidebar sections", title: "Memory", scope: .synced)
        case .navigationInsights: .init(category: .navigation, section: "Sidebar sections", title: "Insights", scope: .synced)
        case .navigationFeedbackButton: .init(category: .navigation, section: "Sidebar sections", title: "Feedback Button", scope: .synced)
        case .navigationCronSessions: .init(category: .navigation, section: "Included Chats", title: "Cron Sessions", scope: .synced)
        case .navigationWebhookSessions: .init(category: .navigation, section: "Included Chats", title: "Webhook Sessions", scope: .synced)
        case .navigationCLISessions: .init(category: .navigation, section: "Included Chats", title: "CLI Sessions", scope: .device)
        case .navigationClaudeCodeSessions: .init(category: .navigation, section: "Included Chats", title: "Claude Code Sessions", scope: .device)
        case .navigationSubagentSessions: .init(category: .navigation, section: "Included Chats", title: "Subagent Sessions", scope: .synced)
        case .navigationSidebarQuotas: .init(category: .navigation, section: "Quotas", title: "Sidebar Quotas", scope: .synced)
        case .navigationProviderIcons: .init(category: .navigation, section: "Quota Display", title: "Provider Icons", scope: .synced)
        case .navigationQuotaPercentage: .init(category: .navigation, section: "Quota Display", title: "Quota Percentage", scope: .synced)
        case .navigationQuotaRefresh: .init(category: .navigation, section: "Quota Display", title: "Quota Refresh", scope: .synced)
        case .notificationsHapticFeedback: .init(category: .notificationsAndHaptics, section: "Alerts & Haptics", title: "Haptic Feedback", scope: .synced)
        case .notificationsResponseCompleteAlerts: .init(category: .notificationsAndHaptics, section: "Alerts & Haptics", title: "Response Complete Alerts", scope: .device)
        case .notificationsApprovalAndQuestionAlerts: .init(category: .notificationsAndHaptics, section: "Alerts & Haptics", title: "Approval and Question Alerts", scope: .device)
        case .notificationsApprovalInputAlerts: .init(category: .notificationsAndHaptics, section: "Alerts & Haptics", title: "Approval & Input Alerts", scope: .device)
        case .notificationsProviderQuotaAlerts: .init(category: .notificationsAndHaptics, section: "Provider Quotas", title: "Provider Quota Alerts", scope: .synced)
        case .notificationsWarningAlerts: .init(category: .notificationsAndHaptics, section: "Provider Quotas", title: "Warning Alerts", scope: .synced)
        case .notificationsCriticalAlerts: .init(category: .notificationsAndHaptics, section: "Provider Quotas", title: "Critical Alerts", scope: .synced)
        case .notificationsTimeSensitive: .init(category: .notificationsAndHaptics, section: "Provider Quotas", title: "Time Sensitive", scope: .synced)
        case .speechDictationProvider: .init(category: .speech, section: "Speech", title: "Dictation Provider", scope: .synced)
        case .modelsDefaultModel: .init(category: .models, section: "Models", title: "Default Model", scope: .profile)
        case .modelsDefaultReasoning: .init(category: .models, section: "Models", title: "Default Reasoning", scope: .profile)
        case .modelsShowThinking: .init(category: .models, section: "Models", title: "Show Thinking", scope: .profile)
        case .modelsAuxiliaryModels: .init(category: .models, section: "Models", title: "Auxiliary Models", scope: .profile)
        case .modelsMaxTokens: .init(category: .models, section: "Limits", title: "Max Tokens", scope: .profile)
        case .modelsPrepareCompressionAhead: .init(category: .models, section: "Limits", title: "Prepare Compression Ahead", scope: .profile)
        case .systemRefreshTitlesEvery: .init(category: .system, section: "System", title: "Refresh Titles Every", scope: .server)
        case .providersManageProviders: .init(category: .providers, section: "Providers", title: "Providers", scope: .profile)
        case .toolsAgentApprovals: .init(category: .tools, section: "Approvals", title: "Agents can approve other chats' commands", scope: .profile)
        case .profilesList: .init(category: .profiles, section: "Profiles", title: "Profiles", scope: .server)
        case .profilesNewProfile: .init(category: .profiles, section: "Profiles", title: "New Profile", scope: .server)
        case .workspacesAddWorkspace: .init(category: .workspaces, section: "Workspaces", title: "Add Workspace", scope: .server)
        case .systemCheckForUpdates: .init(category: .system, section: "Updates", title: "Check for Updates", scope: .server)
        case .systemApplyWebUpdatesAutomatically: .init(category: .system, section: "Updates", title: "Apply Web Updates Automatically", scope: .server)
        case .systemSummarizeUpdates: .init(category: .system, section: "Updates", title: "Summarize Updates", scope: .server)
        case .systemWebChannel: .init(category: .system, section: "Updates", title: "Web Channel", scope: .server)
        case .systemAgentChannel: .init(category: .system, section: "Updates", title: "Agent Channel", scope: .server)
        case .systemIgnoreAgentUpdates: .init(category: .system, section: "Updates", title: "Ignore Agent Updates", scope: .server)
        case .systemStatus: .init(category: .system, section: "System", title: "Status", scope: .server)
        case .systemVersion: .init(category: .system, section: "System", title: "Version", scope: .server)
        case .systemCheckNow: .init(category: .system, section: "System", title: "Check for updates", scope: .server)
        case .systemHermesAgent: .init(category: .system, section: "System", title: "Hermes Agent", scope: .server)
        case .systemUpdate: .init(category: .system, section: "System", title: "Update", scope: .server)
        case .systemUpdateSummary: .init(category: .system, section: "System", title: "Summarize with AI", scope: .server)
        case .logsFile: .init(category: .logs, section: "Logs", title: "File", scope: .server)
        case .logsLines: .init(category: .logs, section: "Logs", title: "Lines", scope: .server)
        case .logsLogText: .init(category: .logs, section: "Logs", title: "Log text", scope: .server)
        case .logsShare: .init(category: .logs, section: "Logs", title: "Share", scope: .server)
        case .serversList: .init(category: .servers, section: "Servers", title: "Servers", scope: .synced)
        case .serversAddServer: .init(category: .servers, section: "Servers", title: "Add Server", scope: .synced)
        case .serversConnectionHeaders: .init(category: .servers, section: "Servers", title: "Connection Headers", scope: .synced)
        case .serversSignOutOfThisServer: .init(category: .servers, section: "Server Access", title: "Sign Out of This Server", scope: .device)
        case .liveActivitiesAndWidgetsDisplay: .init(category: .liveActivitiesAndWidgets, section: "Live Activities", title: "Display", scope: .synced)
        case .liveActivitiesAndWidgetsLiveActivityExcerpts: .init(category: .liveActivitiesAndWidgets, section: "Live Activities", title: "Live Activity Excerpts", scope: .synced)
        case .liveActivitiesAndWidgetsProviderQuotas: .init(category: .liveActivitiesAndWidgets, section: "Widgets", title: "Provider Quotas", scope: .device)
        case .siriAndShortcutsOpenTalariaSettings: .init(category: .siriAndShortcuts, section: "Siri & Shortcuts", title: "Open Talaria Settings", scope: .device)
        case .dataAndStorageClearOfflineCache: .init(category: .dataAndStorage, section: "Offline Data", title: "Clear Offline Cache", scope: .device)
        case .dataAndStorageAppLock: .init(category: .dataAndStorage, section: "App Lock", title: "App Lock", scope: .device)
        case .aboutVersion: .init(category: .about, section: "App", title: "Version", scope: .device)
        case .aboutBuild: .init(category: .about, section: "App", title: "Build", scope: .device)
        case .aboutWhatsNew: .init(category: .about, section: "App", title: "What's New", scope: .device)
        case .aboutSendFeedback: .init(category: .about, section: "App", title: "Send Feedback", scope: .device)
        case .aboutPrivacyPolicy: .init(category: .about, section: "App", title: "Privacy Policy", scope: .device)
        case .aboutSupport: .init(category: .about, section: "App", title: "Support", scope: .device)
        case .aboutAcknowledgements: .init(category: .about, section: "App", title: "Acknowledgements", scope: .device)
        case .developerStreamingLab: .init(category: .developer, section: "Developer", title: "Streaming Lab", scope: .device)
        case .sidebarQuotasDetail: .init(category: .navigation, section: "Quotas Group", title: "Detail", scope: .synced)
        case .sidebarQuotasProviderIcon: .init(category: .navigation, section: "Quotas Group", title: "Provider Icon", scope: .synced)
        case .sidebarQuotasQuotaRail: .init(category: .navigation, section: "Quotas Group", title: "Quota Rail", scope: .synced)
        case .sidebarQuotasPaceMarker: .init(category: .navigation, section: "Quotas Group", title: "Pace Marker", scope: .synced)
        case .sidebarQuotasColorByState: .init(category: .navigation, section: "Quotas Group", title: "Color by State", scope: .synced)
        case .widgetColor: .init(category: .liveActivitiesAndWidgets, section: "Gauge", title: "Color", scope: .synced)
        case .widgetCustomColor: .init(category: .liveActivitiesAndWidgets, section: "Gauge", title: "Custom Color", scope: .synced)
        case .widgetWeight: .init(category: .liveActivitiesAndWidgets, section: "Gauge", title: "Weight", scope: .synced)
        case .widgetAutomaticColor: .init(category: .liveActivitiesAndWidgets, section: "Gauge", title: "Automatic Color", scope: .synced)
        case .widgetShowPaceMarker: .init(category: .liveActivitiesAndWidgets, section: "Gauge", title: "Show Pace Marker", scope: .synced)
        case .widgetProviderIcon: .init(category: .liveActivitiesAndWidgets, section: "Labels", title: "Provider Icon", scope: .synced)
        case .widgetIconStyle: .init(category: .liveActivitiesAndWidgets, section: "Labels", title: "Icon Style", scope: .synced)
        case .widgetStatus: .init(category: .liveActivitiesAndWidgets, section: "Labels", title: "Status", scope: .synced)
        case .widgetReset: .init(category: .liveActivitiesAndWidgets, section: "Labels", title: "Reset", scope: .synced)
        case .widgetLockScreenProviderIcon: .init(category: .liveActivitiesAndWidgets, section: "Lock Screen", title: "Provider Icon", scope: .synced)
        case .widgetResetTime: .init(category: .liveActivitiesAndWidgets, section: "Lock Screen", title: "Reset Time", scope: .synced)
        case .widgetQuotaWindow: .init(category: .liveActivitiesAndWidgets, section: "Lock Screen", title: "Quota Window", scope: .synced)
        case .widgetPaceFooter: .init(category: .liveActivitiesAndWidgets, section: "Lock Screen", title: "Pace Footer", scope: .synced)
        case .widgetTrackColor: .init(category: .liveActivitiesAndWidgets, section: "Surface", title: "Track Color", scope: .synced)
        case .widgetCustomTrackColor: .init(category: .liveActivitiesAndWidgets, section: "Surface", title: "Custom Track Color", scope: .synced)
        case .widgetTrackOpacity: .init(category: .liveActivitiesAndWidgets, section: "Surface", title: "Track Opacity", scope: .synced)
        case .widgetBackground: .init(category: .liveActivitiesAndWidgets, section: "Surface", title: "Background", scope: .synced)
        case .widgetCustomBackgroundColor: .init(category: .liveActivitiesAndWidgets, section: "Surface", title: "Custom Background Color", scope: .synced)
        case .widgetBackgroundOpacity: .init(category: .liveActivitiesAndWidgets, section: "Surface", title: "Background Opacity", scope: .synced)
        case .widgetTap: .init(category: .liveActivitiesAndWidgets, section: "Behavior", title: "Tap", scope: .synced)
        case .widgetHealthy: .init(category: .liveActivitiesAndWidgets, section: "Automatic Colors", title: "Healthy", scope: .synced)
        case .widgetWarning: .init(category: .liveActivitiesAndWidgets, section: "Automatic Colors", title: "Warning", scope: .synced)
        case .widgetCritical: .init(category: .liveActivitiesAndWidgets, section: "Automatic Colors", title: "Critical", scope: .synced)
        case .widgetStale: .init(category: .liveActivitiesAndWidgets, section: "Automatic Colors", title: "Stale", scope: .synced)
        case .widgetUnavailable: .init(category: .liveActivitiesAndWidgets, section: "Automatic Colors", title: "Unavailable", scope: .synced)
        case .providersOverPaceAt: .init(category: .providers, section: "Pace Breakpoints", title: "Over pace at", scope: .profile)
        case .providersWarningBurnRate: .init(category: .providers, section: "Pace Breakpoints", title: "Warning burn rate", scope: .profile)
        case .providersCriticalBurnRate: .init(category: .providers, section: "Pace Breakpoints", title: "Critical burn rate", scope: .profile)
        case .providersProjectionAfter: .init(category: .providers, section: "Pace Breakpoints", title: "Projection after", scope: .profile)
        case .providersWarningAt: .init(category: .providers, section: "Overall Breakpoints", title: "Warning at", scope: .profile)
        case .providersCriticalAt: .init(category: .providers, section: "Overall Breakpoints", title: "Critical at", scope: .profile)
        case .userProfileSessionsAvatar: .init(category: .appearance, section: "User Profile", title: "Sessions Avatar", scope: .synced)
        case .userProfileDisplayName: .init(category: .appearance, section: "User Profile", title: "Display Name", scope: .synced)
        case .userProfileInitials: .init(category: .appearance, section: "User Profile", title: "Initials", scope: .synced)
        case .appleAccountContinueWithApple: .init(category: .servers, section: "Apple Account", title: "Continue with Apple", scope: .device)
        case .appleAccountSyncServersSettings: .init(category: .servers, section: "iCloud Sync", title: "Sync Servers & Settings", scope: .device)
        case .appleAccountICloudSync: .init(category: .servers, section: "iCloud Sync", title: "iCloud Sync", scope: .device)
        case .widgetCustomHealthyColor: .init(category: .liveActivitiesAndWidgets, section: "Automatic Colors", title: "Custom \(Self.widgetHealthy.title) Color", scope: .synced)
        case .widgetCustomWarningColor: .init(category: .liveActivitiesAndWidgets, section: "Automatic Colors", title: "Custom \(Self.widgetWarning.title) Color", scope: .synced)
        case .widgetCustomCriticalColor: .init(category: .liveActivitiesAndWidgets, section: "Automatic Colors", title: "Custom \(Self.widgetCritical.title) Color", scope: .synced)
        case .widgetCustomStaleColor: .init(category: .liveActivitiesAndWidgets, section: "Automatic Colors", title: "Custom \(Self.widgetStale.title) Color", scope: .synced)
        case .widgetCustomUnavailableColor: .init(category: .liveActivitiesAndWidgets, section: "Automatic Colors", title: "Custom \(Self.widgetUnavailable.title) Color", scope: .synced)
        case .widgetProfiles: .init(category: .liveActivitiesAndWidgets, section: "Widgets", title: "Widget Profiles", scope: .synced)
        case .widgetProfilesAppDefault: .init(category: .liveActivitiesAndWidgets, section: "Widget Profiles", title: "App Default", scope: .synced)
        case .widgetProfilesSaved: .init(category: .liveActivitiesAndWidgets, section: "Widget Profiles", title: "Widget Profiles", scope: .synced)
        case .widgetProfilesSaveCurrent: .init(category: .liveActivitiesAndWidgets, section: "Widget Profiles", title: "Save Current Settings", scope: .synced)
        case .appleAccountRelay: .init(category: .servers, section: "Talaria Relay", title: "Talaria Relay", scope: .device)
        case .appleAccountDisconnect: .init(category: .servers, section: "Manage", title: "Disconnect", scope: .device)
        case .appleAccountDeleteSyncedData: .init(category: .servers, section: "Manage", title: "Delete Synced Data…", scope: .synced)
        case .appleAccountSyncNow: .init(category: .servers, section: "iCloud Sync", title: "Sync Now", scope: .device)
        }
    }
}
