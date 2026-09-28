import SwiftUI
import UIKit
import TalariaKit

struct AppIconDisclosureLabel: View {
    let selectedAppIcon: AppIconChoice

    var body: some View {
        HStack(spacing: 12) {
            AppIconChoicePreview(icon: selectedAppIcon)

            VStack(alignment: .leading, spacing: 2) {
                Text("App Icon")
                    .font(AppFont.body(weight: .semibold))
                    .foregroundStyle(.primary)

                Text(selectedAppIcon.title)
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
