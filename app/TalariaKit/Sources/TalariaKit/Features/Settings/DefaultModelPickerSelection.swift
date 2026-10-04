import SwiftUI

public enum DefaultModelPickerSelection {
    /// The checkmark rule, static and internal so tests can pin the
    /// decoded-response-to-checked-row mapping without driving SwiftUI.
    ///
    /// `defaultOptionID` is the entry the server says the stored default
    /// selects (`default_option_id`); `defaultModel` is only the exact-id
    /// fallback for an older server's unstamped catalog.
    public static func isChecked(
        _ model: ModelCatalogOption,
        selectedModel: String?,
        selectedProvider: String?,
        defaultOptionID: String?,
        defaultModel: String?
    ) -> Bool {
        // An in-flight tap owns the projection: OR-ing the previous default
        // would leave two rows announcing "Selected" until the save finishes.
        // A custom / providerless save names no catalog row; the custom button
        // owns the spinner via `isSavingCustom`.
        if selectedModel != nil {
            guard selectedProvider != nil else { return false }
            return model.id == selectedModel && model.providerID == selectedProvider
        }
        return model.isSelected(optionID: defaultOptionID, modelID: defaultModel, providerID: nil)
    }
}
