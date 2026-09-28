import TalariaKit
import UIKit

extension AppIconChoice {
    @MainActor
    static var current: AppIconChoice {
        resolved(from: UIApplication.shared.alternateIconName)
    }
}
