import SwiftUI
import UIKit
import TalariaKit

struct AppIconChoicePreview: View {
    @Environment(\.colorScheme) private var colorScheme

    let icon: AppIconChoice

    @ViewBuilder
    var body: some View {
        switch icon {
        case .system:
            AppIconPreviewImage(
                name: colorScheme == .dark ? "AppIconDarkPreview" : "AppIconLightPreview",
                size: 44
            )
        case .light, .dark, .disco, .monochromeLight, .monochromeDark, .gradientLight, .gradientDark:
            if let previewImageName = icon.previewImageName {
                AppIconPreviewImage(name: previewImageName, size: 44)
            }
        }
    }
}
