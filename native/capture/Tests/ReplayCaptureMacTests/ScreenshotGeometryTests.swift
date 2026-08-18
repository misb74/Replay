import Testing
@testable import ReplayCaptureMac

@Test func screenshotCoordinateScaleMatchesLogicalResolutionOnRetina() {
    #expect(screenshotCoordinateScale(
        imageWidth: 1512,
        imageHeight: 982,
        logicalWidth: 1512,
        logicalHeight: 982,
        fallback: 2
    ) == 1)
}

@Test func screenshotCoordinateScaleHandlesPhysicalAndStandardResolution() {
    #expect(screenshotCoordinateScale(
        imageWidth: 3024,
        imageHeight: 1964,
        logicalWidth: 1512,
        logicalHeight: 982,
        fallback: 1
    ) == 2)
    #expect(screenshotCoordinateScale(
        imageWidth: 1920,
        imageHeight: 1080,
        logicalWidth: 1920,
        logicalHeight: 1080,
        fallback: 1
    ) == 1)
}

@Test func screenshotCoordinateScaleFallsBackForMalformedGeometry() {
    #expect(screenshotCoordinateScale(
        imageWidth: 1512,
        imageHeight: 982,
        logicalWidth: 0,
        logicalHeight: 982,
        fallback: 2
    ) == 2)
    #expect(screenshotCoordinateScale(
        imageWidth: 1512,
        imageHeight: 982,
        logicalWidth: nil,
        logicalHeight: nil,
        fallback: .nan
    ) == 1)
}
