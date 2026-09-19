import SwiftUI
import UIKit

struct NavigationBarLeadingMarginObserver: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> NavigationBarLeadingMarginViewController {
        NavigationBarLeadingMarginViewController()
    }

    func updateUIViewController(
        _ uiViewController: NavigationBarLeadingMarginViewController,
        context: Context
    ) {
        uiViewController.applyMargin()
    }
}
