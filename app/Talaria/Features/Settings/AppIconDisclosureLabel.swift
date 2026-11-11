import SwiftUI
import UIKit
import TalariaKit

struct AppIconDisclosureLabel: View {
    let selectedAppIcon: AppIconChoice
    var isExpanded = false

    var body: some View {
        SettingsItemRow(title: String(localized: "App Icon"), subtitle: selectedAppIcon.title,
                        accessorySystemImage: isExpanded ? "chevron.down" : "chevron.forward") {
            AppIconChoicePreview(icon: selectedAppIcon)
        }
    }
}
