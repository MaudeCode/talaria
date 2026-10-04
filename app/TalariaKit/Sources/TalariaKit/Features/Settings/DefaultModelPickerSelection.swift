import SwiftUI

public enum DefaultModelPickerSelection {
    /// The checkmark rule, static and internal so tests can pin the
    /// decoded-response-to-checked-row mapping without driving SwiftUI.
    ///
    /// `defaultModel`/`defaultProvider` are the server's split of the stored
    /// default (`default_bare_id`/`default_provider_id`).
    public static func isChecked(
        _ model: ModelCatalogOption,
        selectedModel: String?,
        selectedProvider: String?,
        defaultModel: String?,
        defaultProvider: String?
    ) -> Bool {
        // An in-flight tap owns the projection: OR-ing the previous default
        // would leave two rows announcing "Selected" until the save finishes.
        // A custom / providerless save names no catalog row; the custom button
        // owns the spinner via `isSavingCustom`.
        if selectedModel != nil {
            guard selectedProvider != nil else { return false }
            return model.matchesSelection(modelID: selectedModel, providerID: selectedProvider)
        }
        return model.matchesSelection(modelID: defaultModel, providerID: defaultProvider)
    }
}
