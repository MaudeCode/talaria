import XCTest
@testable import Talaria
@testable import TalariaKit

final class ProvidersViewTests: XCTestCase {
    @MainActor
    func testExpansionKeyPrefersStableProviderIDWithIndexFallback() {
        XCTAssertEqual(ProvidersView.expansionKey(for: ProviderSummary(id: " openai "), at: 3), "openai")
        XCTAssertEqual(ProvidersView.expansionKey(for: ProviderSummary(id: "   "), at: 3), "#3")
        XCTAssertEqual(ProvidersView.expansionKey(for: ProviderSummary(id: nil), at: 0), "#0")
    }

    @MainActor
    func testExpansionAnimationFollowsReduceMotion() {
        XCTAssertEqual(ProvidersView.expansionAnimation(reduceMotion: false), .snappy(duration: 0.22))
        XCTAssertNil(ProvidersView.expansionAnimation(reduceMotion: true))
    }
}
