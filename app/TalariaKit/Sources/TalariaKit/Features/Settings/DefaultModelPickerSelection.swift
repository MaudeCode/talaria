import SwiftUI

public enum DefaultModelPickerSelection {
    /// The checkmark rule, static and internal so tests can pin the
    /// decoded-response-to-checked-row mapping without driving SwiftUI.
    public static func isChecked(
        _ model: ModelCatalogOption,
        selectedModel: String?,
        selectedProvider: String?,
        defaultModel: String?,
        activeProvider: String?
    ) -> Bool {
        // An in-flight tap owns the projection: OR-ing the previous default
        // would leave two rows announcing "Selected" until the save finishes.
        // A custom / providerless save names no catalog row — matching with
        // `providerID: nil` would tick every bare same-id row after the live
        // overlay. Leave the catalog unchecked; the custom button owns the
        // spinner via `isSavingCustom`.
        if selectedModel != nil {
            guard selectedProvider != nil else { return false }
            return model.matchesSelection(modelID: selectedModel, providerID: selectedProvider)
        }

        // A stored `@provider:` spelling must not be pre-split with
        // `lastIndex(of: ":")` — that turns `@ollama:qwen3:32b` into provider
        // `ollama:qwen3`. Detect the prefix by whether one exists at all
        // (`@cf/meta/...` model ids start with `@` but have no colon, so they
        // stay bare and match against `activeProvider`). Passing nil then
        // lets `matchesSelection` use the row's own `providerID` as the
        // prefix key.
        let defaultProvider: String?
        if defaultModel.map(ProviderQualifiedModelID.init)?.providerPrefix != nil {
            defaultProvider = nil
        } else {
            defaultProvider = activeProvider
        }
        return model.matchesSelection(modelID: defaultModel, providerID: defaultProvider)
    }
}
