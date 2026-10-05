import SafariServices
import SwiftUI

/// A web page a transcript link opened in the in-app Safari sheet (TAL-442).
struct InAppSafariPage: Identifiable {
    let url: URL
    var id: URL { url }
}

/// The system Safari view; its own dismiss button closes the sheet.
struct InAppSafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let safari = SFSafariViewController(url: url)
        safari.preferredControlTintColor = UIColor(named: "AccentColor")
        return safari
    }

    func updateUIViewController(_ safari: SFSafariViewController, context: Context) {}
}
