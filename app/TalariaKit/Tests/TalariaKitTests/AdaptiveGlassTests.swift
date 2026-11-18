import XCTest
@testable import TalariaKit

final class AdaptiveGlassTests: XCTestCase {
    func testGlassPreferenceDefaultsToEnabledUnderItsSyncedKey() {
        XCTAssertTrue(GlassPreference.defaultIsEnabled)
        XCTAssertEqual(GlassPreference.isEnabledKey, "adaptiveGlass.isEnabled")
    }

    func testSurfaceResolutionPrefersOpaqueWhenReduceTransparencyIsEnabled() {
        let surface = AdaptiveGlassSurface.resolve(
            liquidGlassAvailable: true,
            isGlassEnabled: true,
            reduceTransparency: true
        )

        XCTAssertEqual(surface, .opaque)
    }

    func testSurfaceResolutionFallsBackToMaterialWhenLiquidGlassIsUnavailable() {
        let surface = AdaptiveGlassSurface.resolve(
            liquidGlassAvailable: false,
            isGlassEnabled: true,
            reduceTransparency: false
        )

        XCTAssertEqual(surface, .material)
    }

    func testSurfaceResolutionFallsBackToMaterialWhenGlassIsDisabled() {
        let surface = AdaptiveGlassSurface.resolve(
            liquidGlassAvailable: true,
            isGlassEnabled: false,
            reduceTransparency: false
        )

        XCTAssertEqual(surface, .material)
    }

    func testSurfaceResolutionUsesLiquidGlassWhenAvailableEnabledAndAllowed() {
        let surface = AdaptiveGlassSurface.resolve(
            liquidGlassAvailable: true,
            isGlassEnabled: true,
            reduceTransparency: false
        )

        XCTAssertEqual(surface, .liquidGlass)
    }

    func testScrollEdgeTreatmentDisablesWhenSoftEdgesAreUnavailable() {
        let treatment = AdaptiveScrollEdgeTreatment.resolve(
            softScrollEdgesAvailable: false,
            reduceTransparency: false
        )

        XCTAssertEqual(treatment, .disabled)
    }

    func testScrollEdgeTreatmentDisablesWhenReduceTransparencyIsEnabled() {
        let treatment = AdaptiveScrollEdgeTreatment.resolve(
            softScrollEdgesAvailable: true,
            reduceTransparency: true
        )

        XCTAssertEqual(treatment, .disabled)
    }

    func testScrollEdgeTreatmentUsesSoftWhenAvailableAndAllowed() {
        let treatment = AdaptiveScrollEdgeTreatment.resolve(
            softScrollEdgesAvailable: true,
            reduceTransparency: false
        )

        XCTAssertEqual(treatment, .soft)
    }
}
