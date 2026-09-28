import Foundation

extension String {
    public var lastPathComponentFallback: String {
        let component = (self as NSString).lastPathComponent
        return component.isEmpty ? self : component
    }
}
