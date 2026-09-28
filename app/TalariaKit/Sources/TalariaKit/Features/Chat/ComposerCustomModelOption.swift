import SwiftUI

public enum ComposerCustomModelOption {
    public static func customOption(
        modelID: String,
        providerID: String,
        requiresProviderID: Bool
    ) -> ModelCatalogOption? {
        let modelID = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        let providerID = providerID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !modelID.isEmpty, !providerID.isEmpty || !requiresProviderID else { return nil }
        return ModelCatalogOption(
            id: modelID,
            displayName: modelID,
            providerID: providerID.isEmpty ? nil : providerID
        )
    }
}
