import Foundation

/// UserDefaults keys of the quota widget settings whose types are the widget's App Intents configuration values
/// (`AppEnum`s and the saved-profile store). Those types stay in the App and widget; TalariaKit's preference sync
/// needs only their keys.
public enum ProviderQuotaWidgetStorageKeys {
    /// `ProviderQuotaWidgetWindowSelection.storageKey`
    public static let windowSelection = "providerQuota.widgetWindowSelection"
    /// `ProviderQuotaWidgetStatusText.storageKey`
    public static let statusText = "providerQuota.widgetStatusText"
    /// `ProviderQuotaWidgetResetDisplay.storageKey`
    public static let resetDisplay = "providerQuota.widgetResetDisplay"
    /// `ProviderQuotaWidgetTapAction.storageKey`
    public static let tapAction = "providerQuota.widgetTapAction"
    /// `ProviderQuotaWidgetBackground.storageKey`
    public static let background = "providerQuota.widgetBackground"
    /// `ProviderQuotaWidgetBackground.customColorHexKey`
    public static let backgroundCustomColorHex = "providerQuota.widgetCustomBackgroundColorHex"
    /// `ProviderQuotaWidgetBackground.opacityPercentKey`
    public static let backgroundOpacityPercent = "providerQuota.widgetBackgroundOpacityPercent"
    /// `ProviderQuotaWidgetProfileStore.storageKey`
    public static let profiles = "providerQuota.widgetProfiles.v1"
    /// `ProviderQuotaWidgetProfileStore.selectedDefaultProfileKey`
    public static let selectedDefaultProfile = "providerQuota.widgetDefaultProfileID"
}
