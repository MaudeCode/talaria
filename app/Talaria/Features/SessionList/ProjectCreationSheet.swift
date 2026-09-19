import SwiftUI

struct ProjectColorOption: Identifiable, Equatable {
    let name: String
    let hex: String

    var id: String { hex }

    var color: Color {
        Color(hexString: hex) ?? .accentColor
    }
}

enum ProjectCreationPalette {
    static let approvedColors: [ProjectColorOption] = [
        ProjectColorOption(name: String(localized: "Sky"), hex: "#7cb9ff"),
        ProjectColorOption(name: String(localized: "Gold"), hex: "#f5c542"),
        ProjectColorOption(name: String(localized: "Red"), hex: "#e94560"),
        ProjectColorOption(name: String(localized: "Green"), hex: "#50c878"),
        ProjectColorOption(name: String(localized: "Violet"), hex: "#c084fc"),
        ProjectColorOption(name: String(localized: "Orange"), hex: "#fb923c"),
        ProjectColorOption(name: String(localized: "Cyan"), hex: "#67e8f9"),
        ProjectColorOption(name: String(localized: "Pink"), hex: "#f472b6")
    ]

    static func defaultColor(existingProjectCount: Int) -> ProjectColorOption {
        approvedColors[existingProjectCount % approvedColors.count]
    }
}

struct ProjectCreationSheet: View {
    let isSaving: Bool
    let onCancel: () -> Void
    let onSave: (String, String) -> Void

    private let initialColor: ProjectColorOption

    init(
        existingProjectCount: Int,
        isSaving: Bool,
        onCancel: @escaping () -> Void,
        onSave: @escaping (String, String) -> Void
    ) {
        self.isSaving = isSaving
        self.onCancel = onCancel
        self.onSave = onSave
        initialColor = ProjectCreationPalette.defaultColor(existingProjectCount: existingProjectCount)
    }

    var body: some View {
        ProjectFormSheet(
            title: String(localized: "New Project"),
            initialName: "",
            initialColorHex: initialColor.hex,
            isSaving: isSaving,
            onCancel: onCancel
        ) { name, color in
            onSave(name, color ?? initialColor.hex)
        }
    }
}
